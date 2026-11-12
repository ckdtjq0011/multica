import { createHash } from "node:crypto";

const labels = { issue_body: "이슈 본문 전체", workspace: "워크스페이스 지침", comments: "이슈 댓글", transcript: "실행 메시지", documentation: "지침·문서", run_state: "실행 상태" };
const hash = (text) => createHash("sha256").update(text).digest("hex");
const prompt = (tokens) => tokens.input_tokens + tokens.cache_read_tokens + tokens.cache_write_tokens;

function shellLines(command) {
  const lines = [];
  let delimiter;
  for (const line of command.split("\n")) {
    if (delimiter) { if (line.trim() === delimiter) delimiter = undefined; continue; }
    lines.push(line);
    delimiter = line.match(/<<-?\s*['"]?(\w+)['"]?/)?.[1];
  }
  return lines;
}

export function describeOperations(operations) {
  const reads = [];
  let pureRead = operations.length === 1;
  for (const operation of operations) {
    const command = operation.command;
    if (operation.name !== "exec_command" || typeof command !== "string") { pureRead = false; continue; }
    if (/[\n;|&<>`]/.test(command) || command.includes("$(")) pureRead = false;
    let recognized = false;
    for (const line of shellLines(command)) {
      const cli = line.trim().match(/^(?:"?\$MULTICA_CLI_PATH"?|multica)\s+(workspace\s+get|issue\s+(?:get|comment\s+list|run-messages|runs|children|pull-requests))\b(.*)$/);
      if (cli && !/--help\b/.test(cli[2])) {
        const name = cli[1].replace(/\s+/g, " ");
        const kind = name === "workspace get" ? "workspace" : name === "issue get" ? "issue_body" : name === "issue comment list" ? "comments" : name === "issue run-messages" ? "transcript" : "run_state";
        const args = cli[2].split(/\s+(?:>|&&|;)/)[0].trim();
        const bounded = /--since\b|--roots-only\b|--tail\b|--summary\b/.test(args);
        const mode = /--since\b/.test(args) ? "delta" : bounded ? "bounded" : "full";
        const target = args.match(/^([a-z0-9-]+)/i)?.[1] ?? "workspace";
        reads.push({ kind, label: labels[kind], target_hash: hash(target), query_hash: hash(name + " " + args.replace(/\s+/g, " ")), mode });
        recognized = true;
      }
      const cat = line.trim().match(/^cat\s+(.+)$/);
      if (cat && !cat[1].trimStart().startsWith(">")) {
        const files = cat[1].match(/(?:"[^"\n]+"|'[^'\n]+'|[^\s|;&<>]+)/g) ?? [];
        for (const file of files) {
          const path = file.replace(/^['"]|['"]$/g, "");
          if (!path.endsWith(".md") || path.startsWith("-")) continue;
          const display = path.includes("/skills/") ? path.split("/skills/").at(-1) : path.split("/").slice(-2).join("/");
          reads.push({ kind: "documentation", label: display, target_hash: hash(path), query_hash: hash(path), mode: "full" });
          recognized = true;
        }
      }
    }
    if (!recognized) pureRead = false;
  }
  return { reads, pure_read: pureRead && reads.length === 1, label: [...new Set(reads.map((read) => labels[read.kind]))].join(" + ") || "복합 도구 호출" };
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((block) => typeof block === "string" ? block : block.text ?? "").join("");
  return JSON.stringify(value ?? "");
}

function contentText(value) {
  if (Array.isArray(value)) return value.map((block) => contentText(block.text ?? block)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    if ("output" in value) return contentText(value.output);
    if (value.value && typeof value.value === "object" && "output" in value.value) return contentText(value.value.output);
    return JSON.stringify(value);
  }
  if (typeof value !== "string") return String(value ?? "");
  if (/^Script (?:completed|running)[\s\S]*\nOutput:\s*$/.test(value)) return "";
  try { return contentText(JSON.parse(value)); } catch { return value; }
}

function statusProjections(value, line) {
  if (Array.isArray(value)) return value.flatMap((block) => statusProjections(block.text ?? block, line));
  if (typeof value === "string") {
    try { return statusProjections(JSON.parse(value), line); } catch { return []; }
  }
  if (!value || typeof value !== "object") return [];
  if ("output" in value) return statusProjections(value.output, line);
  if (value.value && typeof value.value === "object" && "output" in value.value) return statusProjections(value.value.output, line);
  if (!value.identifier || typeof value.description !== "string" || !value.status) return [];
  const selected = { identifier: value.identifier, status: value.status, revision: value.revision, description_sha256: hash(value.description) };
  const full = Buffer.byteLength(JSON.stringify(value));
  const projected = Buffer.byteLength(JSON.stringify(selected));
  return [{ line, identifier: value.identifier, full_payload_bytes: full, status_projection_bytes: projected, output_reduction_bytes: full - projected, output_reduction_percent: 100 * (full - projected) / full, scope: "status_and_change_detection_only; original body still required for task understanding and local write verification" }];
}

export function analyzeTrace(trace, runID, verifiedModels) {
  const seen = new Set();
  const records = trace.responses.filter((row) => {
    if (!row.response_id || seen.has(row.response_id)) return false;
    seen.add(row.response_id);
    return true;
  });
  const totals = new Map();
  for (const row of records) {
    const total = totals.get(row.model) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    for (const key of Object.keys(total)) total[key] += row.tokens[key];
    totals.set(row.model, total);
  }
  const matchedModels = new Set([...verifiedModels].filter(([model, total]) => {
    const observed = totals.get(model);
    return observed && Object.keys(total).every((key) => total[key] === observed[key]);
  }).map(([model]) => model));
  const responses = records.filter((row) => matchedModels.has(row.model));
  if (!responses.length) return null;
  const requestResponse = new Map();
  for (const row of responses) for (const id of row.request_ids) requestResponse.set(id, row);
  const requests = trace.requests.filter((row) => requestResponse.has(row.call_id));
  const requestByID = new Map(requests.map((row) => [row.call_id, row]));
  const results = trace.results.filter((row) => requestByID.has(row.call_id)).map((row) => {
    const request = requestByID.get(row.call_id);
    const owner = requestResponse.get(row.call_id);
    // A tool's result cannot explain the input of the response that requested it,
    // even when the provider's usage notification arrives after the result.
    const next = responses.find((response) => response.line > row.line && response.line > owner.line);
    const rawText = outputText(row.output);
    const content = contentText(row.output);
    return { run_id: runID, line: row.line, request_line: request.line, label: request.description.label, read_labels: request.description.reads.map((read) => read.label), visible_bytes: Buffer.byteLength(rawText), content_bytes: Buffer.byteLength(content), truncated: /(?:Warning: truncated output|output truncated|Output truncated)/i.test(rawText), content_hash: hash(content), query_hash: request.description.pure_read ? request.description.reads[0].query_hash : null, next_response_line: next?.line ?? null, next_prompt_tokens: next ? prompt(next.tokens) : null };
  });
  const projections = trace.results.filter((row) => requestByID.has(row.call_id)).flatMap((row) => statusProjections(row.output, row.line).map((projection) => ({ ...projection, run_id: runID })));
  const reads = requests.flatMap((row) => row.description.reads.map((read) => ({ ...read, line: row.line, run_id: runID })));
  const first = prompt(responses[0].tokens);
  return {
    run_id: runID, response_count: responses.length,
    prompt_tokens: responses.reduce((sum, row) => sum + prompt(row.tokens), 0), first_prompt_tokens: first,
    last_prompt_tokens: prompt(responses.at(-1).tokens), max_prompt_tokens: Math.max(...responses.map((row) => prompt(row.tokens))),
    exposure_above_first_prompt_tokens: responses.reduce((sum, row) => sum + Math.max(0, prompt(row.tokens) - first), 0),
    context: responses.map((row, index) => ({ response: index + 1, line: row.line, prompt_tokens: prompt(row.tokens), uncached_input_tokens: row.tokens.input_tokens, output_tokens: row.tokens.output_tokens })),
    reads, results, status_projections: projections,
  };
}

export function decisionSupport(diagnostics, source, issue = {}) {
  const available = diagnostics.filter(Boolean);
  const results = available.flatMap((row) => row.results);
  const reads = available.flatMap((row) => row.reads);
  const groups = new Map();
  for (const read of reads) {
    const key = `${read.run_id}/${read.kind}/${read.target_hash}`;
    const label = issue.id && hash(issue.id) === read.target_hash ? `${issue.identifier} ${read.label}` : read.label;
    const group = groups.get(key) ?? { kind: read.kind, label, requests: 0, full_requests: 0, delta_requests: 0, evidence: [] };
    group.requests++;
    if (read.mode === "full") group.full_requests++;
    if (read.mode === "delta") group.delta_requests++;
    group.evidence.push({ run_id: read.run_id, line: read.line });
    groups.set(key, group);
  }
  const identical = new Map();
  const duplicates = [];
  for (const result of results) {
    if (!result.query_hash || result.truncated) continue;
    const key = `${result.run_id}/${result.query_hash}/${result.content_hash}`;
    if (identical.has(key)) duplicates.push({ ...result, previous_line: identical.get(key).line });
    else identical.set(key, result);
  }
  const stats = Object.entries(labels).map(([kind, label]) => ({ kind, label, requests: reads.filter((row) => row.kind === kind).length, full_requests: reads.filter((row) => row.kind === kind && row.mode === "full").length, delta_requests: reads.filter((row) => row.kind === kind && row.mode === "delta").length }));
  const truncated = results.filter((row) => row.truncated);
  const repeated = [...groups.values()].filter((row) => row.requests > 1).sort((a, b) => b.requests - a.requests);
  const biggest = [...results].sort((a, b) => b.visible_bytes - a.visible_bytes).slice(0, 5);
  const projections = available.flatMap((row) => row.status_projections).filter((row) => row.output_reduction_bytes > 0).sort((a, b) => b.output_reduction_bytes - a.output_reduction_bytes);
  const actions = [];
  if (truncated.length) actions.push({ id: "bound_outputs", title: "먼저 큰 조회 결과의 출력을 줄이세요", evidence: `도구 응답 ${results.length}개 중 ${truncated.length}개가 출력 한도를 넘어 잘렸음. 가장 큰 응답은 ${biggest[0].visible_bytes.toLocaleString("en-US")}바이트임.`, action: "이슈·지침·로그 원문은 파일에 저장하고 필요한 상태·변경 부분만 출력하세요. 묶음 조회도 출력 전에 항목과 길이를 제한하세요.", success: "원래 확인할 값과 업무 결과를 보존하면서 잘린 응답 수와 출력 바이트를 줄임.", guardrail: "필수 조회·저장 후 재조회·실패 원인 확인은 유지함.", evidence_refs: truncated.map((row) => ({ run_id: row.run_id, line: row.line })) });
  if (projections.length) {
    const example = projections[0];
    actions.push({ id: "status_projection", title: "상태 확인에 전체 본문을 다시 출력하지 마세요", evidence: `${example.identifier}의 같은 원자료를 상태·revision·본문 해시로 표시하면 ${example.full_payload_bytes.toLocaleString("en-US")} → ${example.status_projection_bytes.toLocaleString("en-US")}바이트(${example.output_reduction_percent.toFixed(2)}% 출력 축소).`, action: "원 응답을 파일에 보관하고 상태 확인에는 필요한 필드만 출력하세요. 본문 저장 확인은 기대한 원문과 로컬에서 대조한 결과를 함께 표시하세요.", success: "상태·변경 감지 값과 필요한 저장 대조가 보존되며 출력 바이트 감소. 이는 같은 JSON의 표시 비교이며 실제 과금 토큰 절감 실험은 아님.", guardrail: "목표·계약·댓글 내용을 처음 이해하거나 변경된 본문을 읽을 때는 이 축약으로 대체하지 않음.", evidence_refs: [{ run_id: example.run_id, line: example.line }] });
  }
  const repeatedDocs = repeated.filter((row) => row.kind === "documentation" || row.kind === "workspace");
  if (repeatedDocs.length) actions.push({ id: "reuse_instructions", title: "같은 실행에서 지침 원문을 다시 가져오는 부분을 줄이세요", evidence: repeatedDocs.map((row) => `${row.label} ${row.requests}회`).join("; "), action: "처음 읽은 지침과 문단을 재사용하고 변경 알림이나 필요한 누락 문단이 있을 때만 추가로 읽으세요.", success: "변경 없는 지침의 재출력 횟수 감소. 기존 권한·필수 규칙의 적용은 보존함.", guardrail: "경로 반복은 재독 후보이며 내용이 같거나 불필요했다는 증거 자체는 아님.", evidence_refs: repeatedDocs.flatMap((row) => row.evidence) });
  const body = repeated.filter((row) => row.kind === "issue_body");
  if (body.length && !projections.length) actions.push({ id: "project_issue_reads", title: "반복되는 이슈 확인은 필요한 필드만 보여주세요", evidence: body.map((row) => `${row.label} ${row.requests}회`).join("; "), action: "원천 조회와 저장 후 대조는 그대로 수행하고 모델에는 상태·revision·실제 변경 문단만 출력하세요. 실행 메시지를 다시 볼 때는 이전 seq 이후의 --since를 사용하세요.", success: "재조회 확인 결과는 동일하게 유지하고 모델에 되돌려 주는 원문 크기를 줄임.", guardrail: "저장 결과 확인이나 새 사용자 요청에 따른 재조회 자체를 중복 낭비로 단정하지 않음.", evidence_refs: body.flatMap((row) => row.evidence) });
  if (duplicates.length) actions.unshift({ id: "reuse_identical_results", title: "동일하게 돌아온 읽기 결과는 재출력 대신 재사용하세요", evidence: `같은 읽기 요청·같은 내용이 다시 돌아온 응답 ${duplicates.length}개, 원문 ${duplicates.reduce((sum, row) => sum + row.content_bytes, 0)}바이트.`, action: "새 사건으로 원천 재확인이 필요하면 조회하되 기존 결과와 같다는 사실만 출력하세요.", success: "동일 원문의 중복 노출을 줄이고 원천 확인은 유지함.", guardrail: "동일 결과는 조회가 불필요했다는 뜻이 아님. 통신 메타데이터만 제거한 내용 해시를 대조함.", evidence_refs: duplicates.map((row) => ({ run_id: row.run_id, line: row.line })) });
  const responseCount = available.reduce((sum, row) => sum + row.response_count, 0);
  const promptTokens = available.reduce((sum, row) => sum + row.prompt_tokens, 0);
  const sourcePrompt = source.input_tokens === null ? null : prompt(source);
  const scenarioPossible = responseCount > 0 && available.every((row) => row.context.every((response) => response.prompt_tokens >= 1000));
  return {
    availability: responseCount ? "available" : "no_verified_response_records", runs: available,
    response_count: responseCount, prompt_tokens: promptTokens, source_prompt_tokens: sourcePrompt,
    prompt_coverage_percent: sourcePrompt > 0 ? 100 * promptTokens / sourcePrompt : null,
    tool_result_count: results.length, visible_tool_output_bytes: results.reduce((sum, row) => sum + row.visible_bytes, 0), truncated_result_count: truncated.length,
    read_patterns: stats, repeated_reads: repeated, identical_read_results: duplicates, biggest_outputs: biggest, status_projections: projections.slice(0, 5),
    actions: actions.map((row, i) => ({ priority: i + 1, ...row, savings_tokens: null, savings_basis: "not_measured" })),
    scenario: scenarioPossible ? { kind: "counterfactual_not_forecast", persistent_context_cut_tokens: 1000, response_count: responseCount, prompt_exposure_reduction_tokens: 1000 * responseCount, assumption: "같은 1,000토큰이 모든 응답의 입력에 계속 남고 응답 수·결과가 달라지지 않는 경우. 캐시/비캐시 내역·가격·실제 절감량은 미측정." } : null,
    caveats: ["Output bytes are text-volume diagnostics, never converted to billing tokens.", "Input growth is measured context exposure, not measured avoidable usage or proof a particular result caused it.", "Mixed batches remain mixed; action evidence is not added as independent token savings.", "Only response-ID records whose per-model totals match stored usage enter this decision support."],
  };
}

export function renderDecision(support) {
  if (!support?.response_count) return ["절감 판단: 검증된 응답별 기록이 없습니다. 합계만으로 줄일 곳을 단정할 수 없습니다."];
  const lines = ["먼저 줄일 곳 — 실제 관측과 실행 방법"];
  for (const row of support.actions) lines.push(`${row.priority}. ${row.title}`, `   근거: ${row.evidence}`, `   방법: ${row.action}`, `   성공 기준: ${row.success}`, `   유지할 조건: ${row.guardrail}`);
  if (!support.actions.length) lines.push("반복·과다 출력의 구체적인 근거가 부족해 특정 작업을 줄이도록 권하지 않습니다.");
  lines.push(`판단 대상: 응답 ${support.response_count}회, 입력 ${support.prompt_tokens.toLocaleString("en-US")}토큰(원천 입력의 ${support.prompt_coverage_percent?.toFixed(2) ?? "—"}%). 도구 출력 ${support.visible_tool_output_bytes.toLocaleString("en-US")}바이트.`);
  for (const row of support.biggest_outputs.slice(0, 3)) lines.push(`큰 응답: ${row.label} · ${row.visible_bytes.toLocaleString("en-US")}바이트${row.truncated ? " · 잘림" : ""} · 원본 ${row.line}줄 (${[...new Set(row.read_labels)].join(", ") || "혼합 호출"}).`);
  for (const row of support.runs) lines.push(`문맥: 첫 입력 ${row.first_prompt_tokens.toLocaleString("en-US")} → 마지막 ${row.last_prompt_tokens.toLocaleString("en-US")}토큰, 최대 ${row.max_prompt_tokens.toLocaleString("en-US")}토큰.`);
  if (support.scenario) lines.push(`가정 계산: 같은 1,000토큰을 전체 ${support.response_count}응답에서 계속 덜 보내면 입력 노출은 ${support.scenario.prompt_exposure_reduction_tokens.toLocaleString("en-US")}토큰 줄어듭니다. 실제 절감량·가격은 미측정입니다.`);
  lines.push("대상 호출·출력 크기·재독 근거는 JSON의 decision_support에서 확인하세요. 아래 활동 배정은 규칙 추정입니다.", "");
  return lines;
}
