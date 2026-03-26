import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type TocEntry = {
  level: number;
  title: string;
  approxPage: number | null;
};

type ApiOk = {
  meta: {
    pagesAnalyzed: number;
    pdfTotalPages: number;
    pageRange: { start: number; end: number };
    pageNumbers?: number[];
    model: string;
  };
  entries: TocEntry[];
};

type ApiErr = { error: string };

type PreviewItem = {
  pageIndex: number;
  mimeType: string;
  data: string;
};

type DetectOk = {
  pdfTotalPages: number;
  scannedRange: { start: number; end: number };
  suggestedTocPages: number[];
  previews: PreviewItem[];
};

const ABS_MAX_SPAN = 40;

function parseManualPages(s: string, maxPage: number): number[] {
  const parts = s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const p of parts) {
    const n = Number.parseInt(p, 10);
    if (Number.isNaN(n) || n < 1 || n > maxPage) continue;
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

const MANUAL_PARSE_MAX_PAGE = 999_999;

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function baseName(file: File | null) {
  if (!file) return "toc";
  return file.name.replace(/\.[^.]+$/, "");
}

function entriesToJson(entries: TocEntry[]): string {
  return JSON.stringify(
    { entries: entries.map(({ level, title, approxPage }) => ({ level, title, approxPage })) },
    null,
    2
  );
}

function entriesToTxt(entries: TocEntry[]): string {
  return entries
    .map((e) => {
      const indent = "  ".repeat(e.level - 1);
      const page = e.approxPage != null ? `  ${e.approxPage}` : "";
      return `${indent}${e.title}${page}`;
    })
    .join("\n");
}

function entriesToCsv(entries: TocEntry[]): string {
  const header = "level,title,page";
  const rows = entries.map((e) => {
    const title = `"${e.title.replace(/"/g, '""')}"`;
    return `${e.level},${title},${e.approxPage ?? ""}`;
  });
  return [header, ...rows].join("\n");
}

type EditEntry = TocEntry & { id: number };

let _nextId = 1;
function makeEntry(e: Partial<TocEntry> = {}): EditEntry {
  return {
    id: _nextId++,
    level: e.level ?? 1,
    title: e.title ?? "",
    approxPage: e.approxPage ?? null,
  };
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [detectLoading, setDetectLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [result, setResult] = useState<ApiOk | null>(null);
  const [editEntries, setEditEntries] = useState<EditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [detectResult, setDetectResult] = useState<DetectOk | null>(null);
  /** 미리보기·추출 시 PDF 총 페이지 수 (후보 찾기 또는 페이지 미리보기 응답으로 설정) */
  const [pdfTotalPagesHint, setPdfTotalPagesHint] = useState<number | null>(
    null
  );
  /** true = 목차 맞음, false = 아님 */
  const [pageOk, setPageOk] = useState<Record<number, boolean>>({});
  const [manualPagesInput, setManualPagesInput] = useState("");
  const [manualPreviews, setManualPreviews] = useState<PreviewItem[]>([]);

  useEffect(() => {
    if (result) {
      setEditEntries(result.entries.map((e) => makeEntry(e)));
    }
  }, [result]);

  const resetWizard = useCallback(() => {
    setDetectResult(null);
    setPdfTotalPagesHint(null);
    setPageOk({});
    setManualPagesInput("");
    setManualPreviews([]);
  }, []);

  const resetAll = useCallback(() => {
    setFile(null);
    setResult(null);
    setError(null);
    resetWizard();
  }, [resetWizard]);

  const onDetect = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!file) {
      setError("PDF 파일을 선택하세요.");
      return;
    }
    setDetectLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/detect-toc-pages", {
        method: "POST",
        body: fd,
      });
      const bodyText = await res.text();
      let data: DetectOk & ApiErr;
      try {
        data = bodyText
          ? (JSON.parse(bodyText) as DetectOk & ApiErr)
          : ({} as DetectOk & ApiErr);
      } catch {
        setError(
          `서버 응답이 JSON이 아닙니다 (${res.status}). 프록시·서버 로그를 확인하세요.`
        );
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `요청 실패 (${res.status})`);
        return;
      }
      if ("error" in data && data.error) {
        setError(data.error);
        return;
      }
      const ok = data as DetectOk;
      setDetectResult(ok);
      setPdfTotalPagesHint(ok.pdfTotalPages);
      const init: Record<number, boolean> = {};
      for (const pr of ok.previews) {
        init[pr.pageIndex] = true;
      }
      setPageOk(init);
      setManualPagesInput("");
      setManualPreviews([]);
    } catch {
      setError("네트워크 오류입니다. 서버가 실행 중인지 확인하세요.");
    } finally {
      setDetectLoading(false);
    }
  }, [file]);

  const onManualPreview = useCallback(async () => {
    setError(null);
    if (!file) {
      setError("PDF 파일을 선택하세요.");
      return;
    }
    if (!detectResult) {
      setError("먼저「목차 후보 페이지 찾기」를 실행하세요.");
      return;
    }
    const maxP =
      detectResult.pdfTotalPages ?? pdfTotalPagesHint ?? MANUAL_PARSE_MAX_PAGE;
    const nums = parseManualPages(manualPagesInput, maxP);
    if (nums.length === 0) {
      setError("미리볼 유효한 페이지 번호를 입력하세요. (쉼표 또는 공백으로 구분)");
      return;
    }
    if (nums.length > ABS_MAX_SPAN) {
      setError(`한 번에 최대 ${ABS_MAX_SPAN}페이지까지 미리보기할 수 있습니다.`);
      return;
    }
    setPreviewLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("pages", JSON.stringify(nums));
      const res = await fetch("/api/page-previews", {
        method: "POST",
        body: fd,
      });
      const bodyText = await res.text();
      let data: { previews: PreviewItem[]; pdfTotalPages: number } & ApiErr;
      try {
        data = bodyText
          ? (JSON.parse(bodyText) as typeof data)
          : ({} as typeof data);
      } catch {
        setError(`서버 응답 파싱 실패 (${res.status})`);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `요청 실패 (${res.status})`);
        return;
      }
      setPdfTotalPagesHint(data.pdfTotalPages);
      setManualPreviews((prev) => {
        const map = new Map(prev.map((p) => [p.pageIndex, p]));
        for (const p of data.previews ?? []) {
          map.set(p.pageIndex, p);
        }
        return [...map.values()].sort((a, b) => a.pageIndex - b.pageIndex);
      });
    } catch {
      setError("네트워크 오류입니다.");
    } finally {
      setPreviewLoading(false);
    }
  }, [file, detectResult, manualPagesInput, pdfTotalPagesHint]);

  const finalPageNumbers = useMemo(() => {
    if (!detectResult) return [];
    const maxP =
      detectResult.pdfTotalPages ?? pdfTotalPagesHint ?? MANUAL_PARSE_MAX_PAGE;
    const seen = new Set<number>();
    const add = (n: number) => {
      if (!seen.has(n)) seen.add(n);
    };
    for (const pr of detectResult.previews) {
      if (pageOk[pr.pageIndex] !== false) add(pr.pageIndex);
    }
    for (const n of parseManualPages(manualPagesInput, maxP)) {
      add(n);
    }
    return [...seen].sort((a, b) => a - b);
  }, [detectResult, pageOk, manualPagesInput, pdfTotalPagesHint]);

  const previewByPage = useMemo(() => {
    const m = new Map<number, PreviewItem>();
    for (const p of detectResult?.previews ?? []) m.set(p.pageIndex, p);
    for (const p of manualPreviews) m.set(p.pageIndex, p);
    return m;
  }, [detectResult, manualPreviews]);

  const resultDisplayPages = useMemo(() => {
    if (!result) return [];
    const nums = result.meta.pageNumbers;
    if (nums?.length) return nums;
    const { start, end } = result.meta.pageRange;
    const out: number[] = [];
    for (let p = start; p <= end; p++) out.push(p);
    return out;
  }, [result]);

  const manualOnlyOnLeft = useMemo(() => {
    const d = detectResult?.previews ?? [];
    const set = new Set(d.map((p) => p.pageIndex));
    return manualPreviews.filter((p) => !set.has(p.pageIndex));
  }, [detectResult, manualPreviews]);

  const updateEntry = useCallback(
    (id: number, patch: Partial<TocEntry>) =>
      setEditEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...patch } : e))
      ),
    []
  );

  const deleteEntry = useCallback(
    (id: number) =>
      setEditEntries((prev) => prev.filter((e) => e.id !== id)),
    []
  );

  const addEntryAfter = useCallback(
    (id: number) =>
      setEditEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === id);
        const ref = prev[idx];
        const fresh = makeEntry({ level: ref?.level ?? 1 });
        const next = [...prev];
        next.splice(idx + 1, 0, fresh);
        return next;
      }),
    []
  );

  const downloadAs = useCallback(
    (fmt: "json" | "txt" | "csv") => {
      if (editEntries.length === 0) return;
      const name = baseName(file);
      const entries = editEntries.map(({ level, title, approxPage }) => ({
        level,
        title,
        approxPage,
      }));
      if (fmt === "json") {
        downloadBlob(
          new Blob([entriesToJson(entries)], { type: "application/json" }),
          `${name}-toc.json`
        );
      } else if (fmt === "txt") {
        downloadBlob(
          new Blob([entriesToTxt(entries)], { type: "text/plain;charset=utf-8" }),
          `${name}-toc.txt`
        );
      } else {
        downloadBlob(
          new Blob(["\uFEFF" + entriesToCsv(entries)], {
            type: "text/csv;charset=utf-8",
          }),
          `${name}-toc.csv`
        );
      }
    },
    [editEntries, file]
  );

  const addEntryAtEnd = useCallback(
    () =>
      setEditEntries((prev) => [
        ...prev,
        makeEntry({ level: prev.at(-1)?.level ?? 1 }),
      ]),
    []
  );

  const moveEntry = useCallback(
    (id: number, dir: -1 | 1) =>
      setEditEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === id);
        const swapIdx = idx + dir;
        if (swapIdx < 0 || swapIdx >= prev.length) return prev;
        const next = [...prev];
        [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
        return next;
      }),
    []
  );

  /** 후보 찾기 완료 후 또는 추출 결과가 있을 때만 좌우 작업 영역 표시 */
  const splitActive = Boolean(detectResult || result);

  const onExtractFromWizard = useCallback(async () => {
    setError(null);
    setResult(null);
    if (!file) {
      setError("PDF 파일을 선택하세요.");
      return;
    }
    if (!detectResult) {
      setError("먼저「목차 후보 페이지 찾기」를 실행하세요.");
      return;
    }
    if (finalPageNumbers.length === 0) {
      setError(
        "추출할 페이지가 없습니다. 후보에서「목차 맞음」을 켜 두거나, 오른쪽에 페이지 번호를 입력하세요."
      );
      return;
    }
    if (finalPageNumbers.length > ABS_MAX_SPAN) {
      setError(`한 번에 최대 ${ABS_MAX_SPAN}페이지까지 추출할 수 있습니다.`);
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("pages", JSON.stringify(finalPageNumbers));
      const res = await fetch("/api/extract-toc", {
        method: "POST",
        body: fd,
      });
      const bodyText = await res.text();
      let data: ApiOk & ApiErr;
      try {
        data = bodyText
          ? (JSON.parse(bodyText) as ApiOk & ApiErr)
          : ({} as ApiOk & ApiErr);
      } catch {
        setError(
          `서버 응답이 JSON이 아닙니다 (${res.status}). 프록시·서버 로그를 확인하세요.`
        );
        return;
      }
      if (!res.ok) {
        setError(data.error ?? `요청 실패 (${res.status})`);
        return;
      }
      if ("error" in data && data.error) {
        setError(data.error);
        return;
      }
      setResult(data as ApiOk);
    } catch {
      setError("네트워크 오류입니다. 서버가 실행 중인지 확인하세요.");
    } finally {
      setLoading(false);
    }
  }, [file, detectResult, finalPageNumbers]);

  return (
    <div className="layout">
      <header className="header">
        <h1 className="title">PDF 목차 추출</h1>
        <p className="subtitle">
          PDF를 업로드하면 목차로 보이는 페이지를 찾아 미리보기로 확인할 수
          있습니다. 오른쪽에서 페이지를 지정해「왼쪽에 추가」하면 그 페이지로
          목차를 추출합니다.
        </p>
      </header>

      <main className="card">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          {!detectResult && !result ? (
            <>
              <label className="field">
                <span className="label">PDF 파일</span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setFile(f);
                    resetWizard();
                    setResult(null);
                    setError(null);
                  }}
                />
              </label>

              <div className="wizard-actions">
                <button
                  type="button"
                  className="submit"
                  disabled={!file || detectLoading || loading}
                  onClick={onDetect}
                >
                  {detectLoading
                    ? "후보 찾는 중…"
                    : "목차 후보 페이지 찾기"}
                </button>
              </div>
            </>
          ) : (
            <div className="wizard-actions">
              <button
                type="button"
                className="secondary"
                disabled={loading || detectLoading}
                onClick={resetAll}
              >
                다른 PDF 선택
              </button>
            </div>
          )}

          {splitActive && (
            <div
              className={
                result ? "split-pane split-pane--result" : "split-pane"
              }
            >
              <div className="split-col split-col--images">
                <h2 className="split-heading">
                  {result ? "분석에 쓴 목차 페이지" : "목차 후보 · 미리보기"}
                </h2>
                {result ? (
                  resultDisplayPages.length === 0 ? (
                    <p className="split-placeholder">표시할 페이지가 없습니다.</p>
                  ) : (
                    <ul className="preview-list preview-list--scroll">
                      {resultDisplayPages.map((pageIndex) => {
                        const pr = previewByPage.get(pageIndex);
                        return (
                          <li key={`r-${pageIndex}`} className="preview-card">
                            <div className="preview-head">
                              <span className="preview-page">
                                {pageIndex}페이지
                              </span>
                            </div>
                            {pr ? (
                              <img
                                className="preview-img"
                                alt={`PDF ${pageIndex}페이지`}
                                src={`data:${pr.mimeType};base64,${pr.data}`}
                              />
                            ) : (
                              <p className="split-placeholder split-placeholder--inline">
                                이 페이지 미리보기가 없습니다. 같은 PDF에서
                                후보 찾기 또는「왼쪽에 추가」로 이미지를 먼저
                                불러오세요.
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : (
                  <div className="preview-stack preview-list--scroll">
                    {detectResult && detectResult.previews.length > 0 && (
                      <ul className="preview-list preview-list--nested">
                        {detectResult.previews.map((pr) => (
                          <li key={pr.pageIndex} className="preview-card">
                            <div className="preview-head">
                              <span className="preview-page">
                                {pr.pageIndex}페이지
                              </span>
                              <span className="preview-hint">
                                이 페이지가 목차인가요?
                              </span>
                            </div>
                            <img
                              className="preview-img"
                              alt={`PDF ${pr.pageIndex}페이지`}
                              src={`data:${pr.mimeType};base64,${pr.data}`}
                            />
                            <div className="choice-row">
                              <button
                                type="button"
                                className={
                                  pageOk[pr.pageIndex] !== false
                                    ? "choice choice-on"
                                    : "choice"
                                }
                                onClick={() =>
                                  setPageOk((m) => ({
                                    ...m,
                                    [pr.pageIndex]: true,
                                  }))
                                }
                              >
                                목차 맞음
                              </button>
                              <button
                                type="button"
                                className={
                                  pageOk[pr.pageIndex] === false
                                    ? "choice choice-off"
                                    : "choice"
                                }
                                onClick={() =>
                                  setPageOk((m) => ({
                                    ...m,
                                    [pr.pageIndex]: false,
                                  }))
                                }
                              >
                                목차 아님
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {manualOnlyOnLeft.length > 0 && (
                      <>
                        {(detectResult?.previews?.length ?? 0) > 0 && (
                          <p className="split-subheading">직접 추가한 페이지</p>
                        )}
                        <ul className="preview-list preview-list--nested">
                          {manualOnlyOnLeft.map((pr) => (
                            <li
                              key={`add-${pr.pageIndex}`}
                              className="preview-card"
                            >
                              <div className="preview-head">
                                <span className="preview-page">
                                  {pr.pageIndex}페이지
                                </span>
                                <span className="preview-hint">직접 지정</span>
                              </div>
                              <img
                                className="preview-img"
                                alt={`PDF ${pr.pageIndex}페이지`}
                                src={`data:${pr.mimeType};base64,${pr.data}`}
                              />
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {detectResult &&
                      detectResult.previews.length === 0 &&
                      manualOnlyOnLeft.length === 0 && (
                        <p className="split-placeholder">
                          이 구간에서 목차 후보를 찾지 못했습니다. 오른쪽에
                          페이지 번호를 입력해「왼쪽에 추가」한 뒤 추출하세요.
                        </p>
                      )}
                  </div>
                )}
              </div>

              <div className="split-col split-col--toc">
                <h2 className="split-heading">
                  {result ? "추출한 목차" : "페이지 지정 · 추출"}
                </h2>
                {result ? (
                  <section className="out split-out">
                    <p className="meta">
                      PDF 전체 {result.meta.pdfTotalPages}페이지 · 분석 페이지{" "}
                      {result.meta.pageNumbers?.length
                        ? result.meta.pageNumbers.join(", ")
                        : `${result.meta.pageRange.start}–${result.meta.pageRange.end}`}{" "}
                      ({result.meta.pagesAnalyzed}장) · {result.meta.model}
                    </p>
                    {editEntries.length === 0 ? (
                      <p className="msg">
                        추출된 항목이 없습니다. 아래 버튼으로 직접 추가하거나
                        다른 페이지를 선택해 다시 시도해 보세요.
                      </p>
                    ) : (
                      <ul className="toc toc-edit toc--scroll">
                        {editEntries.map((row, i) => (
                          <li
                            key={row.id}
                            className="toc-edit-row"
                          >
                            <div className="toc-edit-indent">
                              <select
                                className="toc-level-select"
                                value={row.level}
                                title="계층 (1=장, 2=절, 3=항)"
                                onChange={(e) =>
                                  updateEntry(row.id, {
                                    level: Number(e.target.value),
                                  })
                                }
                              >
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                              </select>
                            </div>
                            <input
                              type="text"
                              className="toc-title-input"
                              style={{
                                paddingLeft: `${(row.level - 1) * 10 + 6}px`,
                              }}
                              value={row.title}
                              placeholder="제목 입력"
                              onChange={(e) =>
                                updateEntry(row.id, { title: e.target.value })
                              }
                            />
                            <input
                              type="number"
                              className="toc-page-input"
                              min={1}
                              value={row.approxPage ?? ""}
                              placeholder="p."
                              onChange={(e) => {
                                const v = e.target.value;
                                updateEntry(row.id, {
                                  approxPage: v === "" ? null : Number(v),
                                });
                              }}
                            />
                            <div className="toc-edit-actions">
                              <button
                                type="button"
                                className="toc-act toc-act--move"
                                disabled={i === 0}
                                title="위로"
                                onClick={() => moveEntry(row.id, -1)}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="toc-act toc-act--move"
                                disabled={i === editEntries.length - 1}
                                title="아래로"
                                onClick={() => moveEntry(row.id, 1)}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="toc-act toc-act--add"
                                title="아래에 항목 추가"
                                onClick={() => addEntryAfter(row.id)}
                              >
                                +
                              </button>
                              <button
                                type="button"
                                className="toc-act toc-act--del"
                                title="삭제"
                                onClick={() => deleteEntry(row.id)}
                              >
                                ×
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="toc-bottom-bar">
                      <button
                        type="button"
                        className="toc-add-btn"
                        onClick={addEntryAtEnd}
                      >
                        + 항목 추가
                      </button>
                      {editEntries.length > 0 && (
                        <div className="dl-group">
                          <span className="dl-label">다운로드</span>
                          <button
                            type="button"
                            className="dl-btn"
                            onClick={() => downloadAs("json")}
                          >
                            JSON
                          </button>
                          <button
                            type="button"
                            className="dl-btn"
                            onClick={() => downloadAs("txt")}
                          >
                            TXT
                          </button>
                          <button
                            type="button"
                            className="dl-btn"
                            onClick={() => downloadAs("csv")}
                          >
                            CSV
                          </button>
                        </div>
                      )}
                    </div>
                  </section>
                ) : (
                  <>
                    <div className="field manual-pages">
                      <span className="label">
                        페이지 지정 (쉼표·공백 구분) — 추가 시 왼쪽에 미리보기
                      </span>
                      <div className="manual-row">
                        <input
                          type="text"
                          className="manual-input"
                          placeholder="예: 10, 11"
                          value={manualPagesInput}
                          onChange={(e) => setManualPagesInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className="secondary"
                          disabled={previewLoading || !file || !detectResult}
                          onClick={onManualPreview}
                        >
                          {previewLoading
                            ? "불러오는 중…"
                            : "왼쪽에 추가"}
                        </button>
                      </div>
                      <p className="field-help">
                        입력한 번호의 미리보기가 왼쪽 목록에 합쳐집니다. 추출에는
                        입력한 번호가 모두 포함됩니다(미리보기 없이도 됨).
                      </p>
                    </div>

                    <div className="wizard-footer">
                      <p className="final-pages">
                        추출에 사용할 페이지:{" "}
                        {finalPageNumbers.length > 0
                          ? finalPageNumbers.join(", ")
                          : "(없음)"}
                      </p>
                      <button
                        type="button"
                        className="submit"
                        disabled={loading || finalPageNumbers.length === 0}
                        onClick={onExtractFromWizard}
                      >
                        {loading ? "목차 추출 중…" : "선택한 페이지로 목차 추출"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

        </form>

        {error && <p className="msg error">{error}</p>}
      </main>
    </div>
  );
}
