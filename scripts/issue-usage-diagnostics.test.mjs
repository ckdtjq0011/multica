import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTrace, decisionSupport, describeOperations, renderDecision } from "./issue-usage-diagnostics.mjs";

const tokens = (input = 80, output = 10, read = 20) => ({ input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_write_tokens: 0 });
const description = (command) => describeOperations([{ name: "exec_command", command }]);
const request = (call_id, line, cmd = "cat /task/skills/workflow/SKILL.md") => ({ call_id, line, description: description(cmd) });
const response = (response_id, line, request_ids, value = tokens()) => ({ response_id, line, request_ids, model: "model", tokens: value });

test("identifies real reads without parsing examples inside heredocs or exporting identifiers", () => {
  const value = description('cat > note.md <<\'EOF\'\n"$MULTICA_CLI_PATH" issue get PRIVATE-1\nEOF\n"$MULTICA_CLI_PATH" issue run-messages abc123 --since 9 --output json');
  assert.equal(value.reads.length, 1);
  assert.equal(value.reads[0].kind, "transcript");
  assert.equal(value.reads[0].mode, "delta");
  assert.equal(value.pure_read, false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE-1|abc123/);
  assert.equal(description('"$MULTICA_CLI_PATH" issue get --help').reads.length, 0);
});

test("tool results link to a later response, never to their own model request", () => {
  const trace = { requests: [request("a", 1), request("b", 6)], responses: [response("one", 2, ["a"]), response("two", 7, ["b"])], results: [{ call_id: "a", line: 3, output: "content" }, { call_id: "b", line: 8, output: "content" }] };
  const value = analyzeTrace(trace, "run", new Map([["model", tokens(160, 20, 40)]]));
  assert.equal(value.results[0].next_response_line, 7);
  assert.equal(value.results[1].next_response_line, null);
  assert.equal(value.prompt_tokens, 200);
  const report = decisionSupport([value], tokens(160, 20, 40));
  assert.equal(report.identical_read_results.length, 1);
  assert.equal(report.prompt_coverage_percent, 100);
  assert.equal(report.actions[0].id, "reuse_identical_results");
  assert.equal(report.actions[0].savings_tokens, null);
});

test("duplicate response IDs and transport metadata do not multiply measured or repeated usage", () => {
  const out = (time) => [{ text: `Script completed\nWall time ${time} seconds\nOutput:\n` }, { text: JSON.stringify({ output: "same\n", chunk_id: String(time), wall_time_seconds: time }) }];
  const trace = { requests: [request("a", 1), request("b", 6)], responses: [response("one", 2, ["a"]), response("one", 4, []), response("two", 7, ["b"])], results: [{ call_id: "a", line: 3, output: out(0.1) }, { call_id: "b", line: 8, output: out(0.2) }] };
  const value = analyzeTrace(trace, "run", new Map([["model", tokens(160, 20, 40)]]));
  const report = decisionSupport([value], tokens(160, 20, 40));
  assert.equal(report.response_count, 2);
  assert.equal(report.identical_read_results.length, 1);
  assert.equal(report.identical_read_results[0].content_bytes, 5);
});

test("unreconciled response records cannot produce decision evidence or a made-up saving", () => {
  const trace = { requests: [request("a", 1)], responses: [response("one", 2, ["a"])], results: [{ call_id: "a", line: 3, output: "large" }] };
  assert.equal(analyzeTrace(trace, "run", new Map([["model", tokens(999)]])), null);
  const report = decisionSupport([null], tokens());
  assert.equal(report.availability, "no_verified_response_records");
  assert.equal(report.scenario, null);
  assert.equal(report.actions.length, 0);
  assert.match(renderDecision(report)[0], /단정할 수 없습니다/);
});

test("mixed-batch truncation is actionable without allocating bytes to paid tokens or leaking contents", () => {
  const trace = {
    requests: [request("a", 1, '"$MULTICA_CLI_PATH" issue get issue1\ncat /task/skills/workflow/SKILL.md'), request("b", 6, '"$MULTICA_CLI_PATH" issue get issue1')],
    responses: [response("one", 2, ["a"]), response("two", 7, ["b"], tokens(180, 10, 20))],
    results: [{ call_id: "a", line: 3, output: "Warning: truncated output\nPRIVATE_SENTINEL_42" }],
  };
  const value = analyzeTrace(trace, "run", new Map([["model", tokens(260, 20, 40)]]));
  const report = decisionSupport([value], tokens(260, 20, 40));
  assert.equal(report.truncated_result_count, 1);
  assert.equal(report.prompt_tokens, 300);
  assert.equal(report.read_patterns.find((row) => row.kind === "issue_body").requests, 2);
  assert.equal(report.actions[0].id, "bound_outputs");
  assert.equal(report.biggest_outputs[0].query_hash, null);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SENTINEL_42/);
  assert.equal(report.scenario, null);
});

test("a context scenario is conditional arithmetic, while status projection measures only output bytes", () => {
  const document = { identifier: "TEST-1", status: "in_progress", revision: 2, description: "PRIVATE_BODY".repeat(1000) };
  const trace = {
    requests: [request("a", 1, '"$MULTICA_CLI_PATH" issue get TEST-1')],
    responses: [response("one", 2, ["a"], tokens(2000))],
    results: [{ call_id: "a", line: 3, output: [{ text: JSON.stringify({ output: JSON.stringify(document) }) }, { text: JSON.stringify({ value: 42 }) }] }],
  };
  const value = analyzeTrace(trace, "run", new Map([["model", tokens(2000)]]));
  const report = decisionSupport([value], tokens(2000));
  assert.equal(report.status_projections[0].full_payload_bytes, Buffer.byteLength(JSON.stringify(document)));
  assert.ok(report.status_projections[0].status_projection_bytes < 200);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY/);
  assert.equal(report.scenario.kind, "counterfactual_not_forecast");
  assert.equal(report.scenario.prompt_exposure_reduction_tokens, 1000);
  assert.equal(report.actions[0].savings_tokens, null);
});

test("repeated targets in different runs and changed results do not establish duplicate output", () => {
  const trace = { requests: [request("a", 1), request("b", 6)], responses: [response("one", 2, ["a"]), response("two", 7, ["b"])], results: [{ call_id: "a", line: 3, output: "old" }, { call_id: "b", line: 8, output: "new" }] };
  const a = analyzeTrace(trace, "run-a", new Map([["model", tokens(160, 20, 40)]]));
  const b = analyzeTrace(trace, "run-b", new Map([["model", tokens(160, 20, 40)]]));
  const report = decisionSupport([a, b], tokens(320, 40, 80));
  assert.equal(report.identical_read_results.length, 0);
  assert.equal(report.repeated_reads.length, 2);
  assert.equal(report.prompt_tokens, 400);
});
