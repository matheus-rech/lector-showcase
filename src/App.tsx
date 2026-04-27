import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// Parcel inlines the worker file as a data: URL so the whole bundle stays in one HTML.
// @ts-expect-error - parcel virtual import
import workerUrl from "data-url:pdfjs-dist/legacy/build/pdf.worker.min.mjs";
import "./App.css";

(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = workerUrl;

type HighlightColor = {
  name: string;
  swatch: string; // tailwind bg
  fill: string; // rgba for canvas/svg
  ring: string; // tailwind ring
};

const COLORS: HighlightColor[] = [
  {
    name: "amber",
    swatch: "bg-amber-300",
    fill: "rgba(252, 211, 77, 0.42)",
    ring: "ring-amber-500",
  },
  {
    name: "emerald",
    swatch: "bg-emerald-300",
    fill: "rgba(110, 231, 183, 0.42)",
    ring: "ring-emerald-500",
  },
  {
    name: "sky",
    swatch: "bg-sky-300",
    fill: "rgba(125, 211, 252, 0.42)",
    ring: "ring-sky-500",
  },
  {
    name: "rose",
    swatch: "bg-rose-300",
    fill: "rgba(253, 164, 175, 0.42)",
    ring: "ring-rose-500",
  },
];

interface PdfBox {
  // PDF user-unit space (origin bottom-left, points)
  x: number;
  y: number;
  width: number;
  height: number;
}

// A normalized rect (0..1 of page width/height) — stable across zoom
interface PctBox {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

// One PDF text item with its viewport-percent box
interface TextSpan extends PctBox {
  str: string;
}

interface Highlight {
  id: string;
  page: number; // 1-based
  // normalized to page width/height for resilience to zoom
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  color: string; // matches HighlightColor.name
  // -- provenance trail --
  quote: string; // exact text the rectangle covers (joined from PDF text items)
  pdfBox: PdfBox; // exact source coords, not viewport pixels
  textItemCount: number; // how many PDF text items were intersected
}

interface PageGeometry {
  width: number;
  height: number;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function App() {
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfName, setPdfName] = useState<string>("No PDF loaded");
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1.15);
  const [currentPage, setCurrentPage] = useState(1);
  const [dark, setDark] = useState(false);
  const [colorIdx, setColorIdx] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [pageGeometry, setPageGeometry] = useState<Record<number, PageGeometry>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({});
  const [pageLines, setPageLines] = useState<Record<number, TextSpan[][]>>({});
  const [leftTab, setLeftTab] = useState<"search" | "extract" | "off">("search");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const activeColor = COLORS[colorIdx];

  // Apply dark class on root
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  // Load PDF from file
  const loadFile = useCallback(async (file: File) => {
    try {
      setLoading(true);
      setLoadError(null);
      const buf = await file.arrayBuffer();
      const task = pdfjsLib.getDocument({
        data: buf,
        isEvalSupported: false,
      });
      const doc = await task.promise;
      setPdf(doc);
      setPdfName(file.name);
      setPageCount(doc.numPages);
      setCurrentPage(1);
      setHighlights([]);
      setPageGeometry({});
      setPageTexts({});
      setPageLines({});
      // Extract text + per-span pct coords per page so search can paint overlays on the PDF
      void (async () => {
        const nextText: Record<number, string> = {};
        const nextLines: Record<number, TextSpan[][]> = {};
        const Util = (pdfjsLib as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;
        for (let p = 1; p <= doc.numPages; p++) {
          try {
            const proxy = await doc.getPage(p);
            const viewport1 = proxy.getViewport({ scale: 1 });
            const W = viewport1.width;
            const H = viewport1.height;
            const tc = await proxy.getTextContent();
            const lineGroups: TextSpan[][] = [];
            let lastY: number | null = null;
            for (const raw of tc.items) {
              const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
              if (typeof item.str !== "string" || !item.transform || item.str.length === 0) continue;
              const m = Util.transform(viewport1.transform, item.transform);
              const itemLeft = m[4];
              const itemBottom = m[5];
              const itemW = (item.width ?? 0);
              const itemH = (item.height ?? 0) || Math.abs(m[3]);
              const itemTop = itemBottom - itemH;
              const span: TextSpan = {
                str: item.str,
                xPct: itemLeft / W,
                yPct: itemTop / H,
                wPct: itemW / W,
                hPct: itemH / H,
              };
              if (lastY === null || Math.abs(itemBottom - lastY) > 2) lineGroups.push([span]);
              else lineGroups[lineGroups.length - 1].push(span);
              lastY = itemBottom;
            }
            nextLines[p] = lineGroups;
            nextText[p] = lineGroups
              .map((line) => line.map((s) => s.str).join(" "))
              .join("\n");
            if (p % 4 === 0 || p === doc.numPages) {
              setPageTexts({ ...nextText });
              setPageLines({ ...nextLines });
            }
          } catch {
            /* skip */
          }
        }
        setPageTexts(nextText);
        setPageLines(nextLines);
      })();
    } catch (err) {
      console.error(err);
      setLoadError("That file could not be parsed as a PDF.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Drop handler
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file && /pdf/i.test(file.type || file.name)) {
        loadFile(file);
      }
    },
    [loadFile]
  );

  // IntersectionObserver to track current page in scroll
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || pageCount === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        let best: { page: number; ratio: number } | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const p = Number((e.target as HTMLElement).dataset.page);
          if (!best || e.intersectionRatio > best.ratio) {
            best = { page: p, ratio: e.intersectionRatio };
          }
        }
        if (best) setCurrentPage(best.page);
      },
      { root, threshold: [0.25, 0.5, 0.75] }
    );
    for (const k of Object.keys(pageRefs.current)) {
      const el = pageRefs.current[Number(k)];
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [pageCount, pdf]);

  const goToPage = useCallback((page: number) => {
    const el = pageRefs.current[page];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const addHighlight = useCallback(
    (h: Omit<Highlight, "id" | "color">) => {
      setHighlights((prev) => [
        ...prev,
        { ...h, id: uid(), color: activeColor.name },
      ]);
    },
    [activeColor.name]
  );

  const removeHighlight = useCallback((id: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const clearHighlights = useCallback(() => setHighlights([]), []);

  const exportHighlights = useCallback(() => {
    downloadJson(`${pdfName.replace(/\.pdf$/i, "")}-highlights.json`, {
      pdf: pdfName,
      pageCount,
      exported_at: new Date().toISOString(),
      highlights,
    });
  }, [pdfName, pageCount, highlights]);

  return (
    <div
      className="flex h-screen w-screen flex-col bg-paper-grain text-foreground"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <Header
        pdfName={pdfName}
        pageCount={pageCount}
        currentPage={currentPage}
        goToPage={goToPage}
        zoom={zoom}
        setZoom={setZoom}
        dark={dark}
        setDark={setDark}
        loadFile={loadFile}
        clearHighlights={clearHighlights}
        exportHighlights={exportHighlights}
        highlightCount={highlights.length}
      />

      <div className="flex min-h-0 flex-1">
        {/* tools left rail: search + extract */}
        <LeftRail
          tab={leftTab}
          setTab={setLeftTab}
          pageTexts={pageTexts}
          pageLines={pageLines}
          pageCount={pageCount}
          goToPage={goToPage}
          pdfName={pdfName}
          onHitsChange={setSearchHits}
        />
        {/* main reader */}
        <div
          ref={scrollerRef}
          className="relative min-h-0 flex-1 overflow-auto px-6 py-8"
        >
          {loading && <SkeletonReader />}
          {!loading && !pdf && (
            <DropHero error={loadError} />
          )}
          {!loading && pdf && (
            <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 pb-20">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                <PdfPage
                  key={p}
                  pdf={pdf}
                  page={p}
                  zoom={zoom}
                  dark={dark}
                  activeColor={activeColor}
                  highlights={highlights.filter((h) => h.page === p)}
                  searchBoxes={searchHits.filter((h) => h.page === p).flatMap((h) => h.boxes)}
                  addHighlight={addHighlight}
                  removeHighlight={removeHighlight}
                  setRef={(el) => {
                    pageRefs.current[p] = el;
                  }}
                  reportGeometry={(g) =>
                    setPageGeometry((prev) =>
                      prev[p] && prev[p].width === g.width && prev[p].height === g.height
                        ? prev
                        : { ...prev, [p]: g }
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* MiniMap rail */}
        <MiniMapRail
          pageCount={pageCount}
          pageGeometry={pageGeometry}
          highlights={highlights}
          currentPage={currentPage}
          goToPage={goToPage}
        />
      </div>

      <Footer
        colors={COLORS}
        colorIdx={colorIdx}
        setColorIdx={setColorIdx}
        highlightCount={highlights.length}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Header                                                                  */
/* ----------------------------------------------------------------------- */

function Header({
  pdfName,
  pageCount,
  currentPage,
  goToPage,
  zoom,
  setZoom,
  dark,
  setDark,
  loadFile,
  clearHighlights,
  exportHighlights,
  highlightCount,
}: {
  pdfName: string;
  pageCount: number;
  currentPage: number;
  goToPage: (p: number) => void;
  zoom: number;
  setZoom: (z: number) => void;
  dark: boolean;
  setDark: (d: boolean) => void;
  loadFile: (f: File) => void;
  clearHighlights: () => void;
  exportHighlights: () => void;
  highlightCount: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card/70 px-5 py-3 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-sm bg-ink text-paper-50 dark:bg-paper-50 dark:text-ink"
          style={{ fontFamily: "Fraunces, serif", fontWeight: 600 }}
        >
          ℓ
        </span>
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg leading-tight">
            lector showcase
          </h1>
          <p className="truncate text-xs text-muted-foreground">{pdfName}</p>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1 py-1 shadow-paper">
          <button
            type="button"
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            className="rounded px-2 py-0.5 text-sm text-foreground hover:bg-muted disabled:opacity-40"
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="min-w-[5.5ch] text-center font-mono text-xs text-muted-foreground">
            {currentPage}
            <span className="opacity-50"> / </span>
            {pageCount || "—"}
          </span>
          <button
            type="button"
            onClick={() => goToPage(Math.min(pageCount, currentPage + 1))}
            className="rounded px-2 py-0.5 text-sm text-foreground hover:bg-muted disabled:opacity-40"
            disabled={currentPage >= pageCount}
            aria-label="Next page"
          >
            ›
          </button>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-border bg-card px-1 py-1 shadow-paper">
          <button
            type="button"
            onClick={() => setZoom(Math.max(0.5, +(zoom - 0.1).toFixed(2)))}
            className="rounded px-2 py-0.5 text-sm hover:bg-muted"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="min-w-[4ch] text-center font-mono text-xs text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom(Math.min(2.5, +(zoom + 0.1).toFixed(2)))}
            className="rounded px-2 py-0.5 text-sm hover:bg-muted"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={exportHighlights}
          disabled={highlightCount === 0}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
        >
          Export {highlightCount > 0 ? `(${highlightCount})` : "JSON"}
        </button>
        <button
          type="button"
          onClick={clearHighlights}
          disabled={highlightCount === 0}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
        >
          Clear
        </button>

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-md border border-border bg-ink px-3 py-1.5 text-xs text-paper-50 hover:bg-ink-50 dark:bg-paper-50 dark:text-ink dark:hover:bg-paper-200"
        >
          Open PDF
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadFile(f);
            e.currentTarget.value = "";
          }}
        />

        <button
          type="button"
          onClick={() => setDark(!dark)}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {dark ? "☀ Light" : "☾ Dark"}
        </button>
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------------- */
/* PDF Page                                                                */
/* ----------------------------------------------------------------------- */

function PdfPage({
  pdf,
  page,
  zoom,
  dark,
  activeColor,
  highlights,
  searchBoxes,
  addHighlight,
  removeHighlight,
  setRef,
  reportGeometry,
}: {
  pdf: pdfjsLib.PDFDocumentProxy;
  page: number;
  zoom: number;
  dark: boolean;
  activeColor: HighlightColor;
  highlights: Highlight[];
  searchBoxes: PctBox[];
  addHighlight: (h: Omit<Highlight, "id" | "color">) => void;
  removeHighlight: (id: string) => void;
  setRef: (el: HTMLDivElement | null) => void;
  reportGeometry: (g: PageGeometry) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<pdfjsLib.PDFPageProxy | null>(null);
  const viewportRef = useRef<pdfjsLib.PageViewport | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<
    | null
    | {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      }
  >(null);

  // Render canvas
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const proxy = await pdf.getPage(page);
      const viewport = proxy.getViewport({ scale: zoom });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const task = proxy.render({ canvasContext: ctx, viewport });
      try {
        await task.promise;
      } catch {
        /* cancelled */
      }
      if (!cancelled) {
        proxyRef.current = proxy;
        viewportRef.current = viewport;
        setSize({ w: viewport.width, h: viewport.height });
        reportGeometry({ width: viewport.width, height: viewport.height });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, page, zoom, reportGeometry]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!wrapperRef.current) return;
    if (e.button !== 0) return;
    const r = wrapperRef.current.getBoundingClientRect();
    setDrag({
      x0: e.clientX - r.left,
      y0: e.clientY - r.top,
      x1: e.clientX - r.left,
      y1: e.clientY - r.top,
    });
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !wrapperRef.current) return;
    const r = wrapperRef.current.getBoundingClientRect();
    setDrag({ ...drag, x1: e.clientX - r.left, y1: e.clientY - r.top });
  };

  const onPointerUp = (_e: React.PointerEvent) => {
    if (!drag || !size) {
      setDrag(null);
      return;
    }
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (w <= 6 || h <= 6) return;

    // Extract underlying text + PDF coords from the page text content (provenance trail)
    void (async () => {
      const proxy = proxyRef.current;
      const viewport = viewportRef.current;
      if (!proxy || !viewport) return;

      const tc = await proxy.getTextContent();
      const rectLeft = x;
      const rectTop = y;
      const rectRight = x + w;
      const rectBottom = y + h;

      const items: { str: string; left: number; top: number; right: number; bottom: number }[] = [];
      // pdfjs.Util.transform may not be in d.ts in all versions — access lazily
      const Util = (pdfjsLib as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;

      for (const raw of tc.items) {
        const item = raw as { str?: string; transform?: number[]; width?: number; height?: number };
        if (typeof item.str !== "string" || !item.transform) continue;
        const m = Util.transform(viewport.transform, item.transform);
        // m[4], m[5] is bottom-left of glyph in viewport pixel coords (y-down)
        const glyphLeft = m[4];
        const glyphBottom = m[5];
        const glyphW = (item.width ?? 0) * viewport.scale;
        const glyphH = (item.height ?? 0) * viewport.scale || Math.abs(m[3]);
        const glyphTop = glyphBottom - glyphH;
        const glyphRight = glyphLeft + glyphW;
        // Intersect with selection rect (use vertical-center test for line-band rectangles)
        const cy = (glyphTop + glyphBottom) / 2;
        if (
          cy >= rectTop &&
          cy <= rectBottom &&
          glyphRight > rectLeft &&
          glyphLeft < rectRight
        ) {
          items.push({
            str: item.str,
            left: glyphLeft,
            top: glyphTop,
            right: glyphRight,
            bottom: glyphBottom,
          });
        }
      }

      // Sort top-to-bottom, then left-to-right
      items.sort((a, b) => a.top - b.top || a.left - b.left);
      const quote = items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();

      // Convert highlight rect to PDF coords using viewport.convertToPdfPoint
      const v = viewport as unknown as {
        convertToPdfPoint: (x: number, y: number) => [number, number];
      };
      const tl = v.convertToPdfPoint(rectLeft, rectTop);
      const br = v.convertToPdfPoint(rectRight, rectBottom);
      const pdfBox: PdfBox = {
        x: Math.min(tl[0], br[0]),
        y: Math.min(tl[1], br[1]),
        width: Math.abs(br[0] - tl[0]),
        height: Math.abs(br[1] - tl[1]),
      };

      addHighlight({
        page,
        xPct: x / size.w,
        yPct: y / size.h,
        wPct: w / size.w,
        hPct: h / size.h,
        quote: quote || "(no text under selection)",
        pdfBox,
        textItemCount: items.length,
      });
    })();
  };

  const dragRect =
    drag && size
      ? {
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
        }
      : null;

  return (
    <div
      ref={(el) => {
        setRef(el);
        wrapperRef.current = el;
      }}
      data-page={page}
      className="relative select-none rounded-sm bg-paper-50 shadow-paper ring-1 ring-paper-300"
      style={{
        width: size?.w,
        height: size?.h,
        cursor: "crosshair",
        filter: dark
          ? "invert(94%) hue-rotate(180deg) brightness(80%) contrast(228%)"
          : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <canvas ref={canvasRef} className="block" />
      {/* search hit overlays — painted under user highlights */}
      {size &&
        searchBoxes.map((b, i) => (
          <span
            key={`s-${i}`}
            className="pointer-events-none absolute rounded-[1px]"
            style={{
              left: b.xPct * size.w,
              top: b.yPct * size.h,
              width: Math.max(2, b.wPct * size.w),
              height: Math.max(2, b.hPct * size.h),
              backgroundColor: "rgba(250, 204, 21, 0.55)",
              outline: "1px solid rgba(217, 119, 6, 0.85)",
              mixBlendMode: dark ? "screen" : "multiply",
            }}
          />
        ))}
      {/* highlight overlays */}
      {size &&
        highlights.map((h) => {
          const c = COLORS.find((x) => x.name === h.color) ?? COLORS[0];
          return (
            <button
              type="button"
              key={h.id}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) removeHighlight(h.id);
              }}
              title="Shift-click to remove"
              className={`absolute rounded-sm outline outline-1 outline-offset-0 ${c.ring}`}
              style={{
                left: h.xPct * size.w,
                top: h.yPct * size.h,
                width: h.wPct * size.w,
                height: h.hPct * size.h,
                backgroundColor: c.fill,
                mixBlendMode: dark ? "screen" : "multiply",
              }}
            />
          );
        })}
      {/* live drag rect */}
      {dragRect && (
        <div
          className="pointer-events-none absolute rounded-sm"
          style={{
            ...dragRect,
            backgroundColor: activeColor.fill,
            outline: "1px dashed currentColor",
          }}
        />
      )}
      <span className="pointer-events-none absolute -bottom-6 right-1 font-mono text-[10px] text-muted-foreground">
        p. {page}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* MiniMap rail                                                            */
/* ----------------------------------------------------------------------- */

function MiniMapRail({
  pageCount,
  pageGeometry,
  highlights,
  currentPage,
  goToPage,
}: {
  pageCount: number;
  pageGeometry: Record<number, PageGeometry>;
  highlights: Highlight[];
  currentPage: number;
  goToPage: (p: number) => void;
}) {
  const RAIL_WIDTH = 110;
  const GAP = 6;

  const layout = useMemo(() => {
    const items: { page: number; top: number; height: number; width: number }[] = [];
    let y = 0;
    for (let p = 1; p <= pageCount; p++) {
      const g = pageGeometry[p];
      const aspect = g ? g.height / g.width : 1.4;
      const h = RAIL_WIDTH * aspect;
      items.push({ page: p, top: y, height: h, width: RAIL_WIDTH });
      y += h + GAP;
    }
    return { items, total: y };
  }, [pageCount, pageGeometry]);

  if (pageCount === 0) return null;

  return (
    <aside className="hidden w-[360px] shrink-0 border-l border-border bg-card/50 lg:flex lg:flex-col">
      {/* MiniMap region */}
      <div className="flex h-[42%] min-h-[220px] flex-col border-b border-border">
        <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
          <p className="font-display text-sm">Map</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {highlights.length} highlight{highlights.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="relative flex-1 overflow-auto px-3 py-3">
          <div
            className="relative mx-auto"
            style={{ width: RAIL_WIDTH, height: layout.total }}
          >
            {layout.items.map((it) => (
              <button
                type="button"
                key={it.page}
                onClick={() => goToPage(it.page)}
                data-testid="minimap-page"
                className={`absolute block rounded-sm border bg-paper-50 transition ${
                  currentPage === it.page
                    ? "border-brass-500 shadow-paper"
                    : "border-paper-300 hover:border-brass-300"
                }`}
                style={{
                  top: it.top,
                  left: 0,
                  width: it.width,
                  height: it.height,
                }}
              >
                <span className="pointer-events-none absolute right-1 top-0.5 font-mono text-[8px] text-ink-50/60">
                  {it.page}
                </span>
                {highlights
                  .filter((h) => h.page === it.page)
                  .map((h) => {
                    const c = COLORS.find((x) => x.name === h.color) ?? COLORS[0];
                    return (
                      <span
                        key={h.id}
                        className="pointer-events-none absolute rounded-[1px]"
                        style={{
                          left: h.xPct * it.width,
                          top: h.yPct * it.height,
                          width: Math.max(2, h.wPct * it.width),
                          height: Math.max(1.5, h.hPct * it.height),
                          backgroundColor: c.fill,
                        }}
                      />
                    );
                  })}
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Provenance panel */}
      <ProvenancePanel highlights={highlights} goToPage={goToPage} />
    </aside>
  );
}

function ProvenancePanel({
  highlights,
  goToPage,
}: {
  highlights: Highlight[];
  goToPage: (p: number) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <p className="font-display text-sm">Provenance</p>
        <p className="font-mono text-[10px] text-muted-foreground">
          quote · page · pdf coords
        </p>
      </div>
      <div className="flex-1 overflow-auto px-3 py-3">
        {highlights.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Drag-select on a page to capture a highlight. The exact text and PDF
            coordinates will appear here as proof of provenance.
          </p>
        ) : (
          <ol className="space-y-3">
            {highlights.map((h, i) => {
              const c = COLORS.find((x) => x.name === h.color) ?? COLORS[0];
              const fmt = (n: number) => n.toFixed(1);
              return (
                <li
                  key={h.id}
                  className="rounded-md border border-border bg-card p-2 shadow-paper"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="inline-block h-3 w-3 rounded-sm border border-paper-300"
                      style={{ backgroundColor: c.fill }}
                    />
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      #{i + 1} · {h.color}
                    </span>
                    <button
                      type="button"
                      onClick={() => goToPage(h.page)}
                      className="ml-auto rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
                    >
                      go to p. {h.page}
                    </button>
                  </div>
                  <blockquote
                    className="border-l-2 pl-2 font-display text-[12.5px] leading-snug text-foreground"
                    style={{ borderColor: c.fill }}
                  >
                    {h.quote.length > 220
                      ? h.quote.slice(0, 220) + "…"
                      : h.quote}
                  </blockquote>
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    pdf · x={fmt(h.pdfBox.x)} y={fmt(h.pdfBox.y)} w=
                    {fmt(h.pdfBox.width)} h={fmt(h.pdfBox.height)} ·{" "}
                    {h.textItemCount} item{h.textItemCount === 1 ? "" : "s"}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Footer                                                                  */
/* ----------------------------------------------------------------------- */

function Footer({
  colors,
  colorIdx,
  setColorIdx,
  highlightCount,
}: {
  colors: HighlightColor[];
  colorIdx: number;
  setColorIdx: (i: number) => void;
  highlightCount: number;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-card/70 px-5 py-2 text-xs">
      <span className="text-muted-foreground">
        Drag on the page to highlight. Shift-click a highlight to delete.
      </span>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-muted-foreground">Color:</span>
        {colors.map((c, i) => (
          <button
            type="button"
            key={c.name}
            onClick={() => setColorIdx(i)}
            aria-label={`Use ${c.name} highlight`}
            className={`h-5 w-5 rounded-full border transition ${
              c.swatch
            } ${
              colorIdx === i
                ? "border-ink ring-2 ring-offset-1 ring-offset-card " + c.ring
                : "border-paper-300 hover:border-ink"
            }`}
          />
        ))}
        <span className="ml-3 font-mono text-muted-foreground">
          {highlightCount} marks
        </span>
      </div>
    </footer>
  );
}

/* ----------------------------------------------------------------------- */
/* Skeleton                                                                */
/* ----------------------------------------------------------------------- */

function SkeletonReader() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="aspect-[1/1.41] w-full animate-pulse rounded-sm bg-paper-200/60 shadow-paper"
        />
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------- */
/* Left rail: Search + Extract                                             */
/* ----------------------------------------------------------------------- */

type LeftTab = "search" | "extract" | "off";
type SearchMode = "text" | "fuzzy" | "regex";

interface SearchHit {
  page: number;
  lineIndex: number;
  line: string;
  matchStart: number;
  matchEnd: number;
  boxes: PctBox[]; // overlay rectangles to paint on the page
}

function spanBoxesForMatch(line: TextSpan[], matchStart: number, matchEnd: number): PctBox[] {
  if (matchEnd <= matchStart) return [];
  const boxes: PctBox[] = [];
  let cursor = 0;
  for (const span of line) {
    const spanStart = cursor;
    const spanEnd = cursor + span.str.length;
    if (spanEnd > matchStart && spanStart < matchEnd) {
      boxes.push({
        xPct: span.xPct,
        yPct: span.yPct,
        wPct: span.wPct,
        hPct: span.hPct,
      });
    }
    cursor = spanEnd + 1; // +1 for the joining space
    if (cursor > matchEnd) break;
  }
  return boxes;
}

function runSearch(
  q: string,
  mode: SearchMode,
  pageLines: Record<number, TextSpan[][]>
): { hits: SearchHit[]; error: string | null } {
  const trimmed = q.trim();
  if (!trimmed) return { hits: [], error: null };
  const hits: SearchHit[] = [];

  let testFn: (line: string) => { start: number; end: number } | null;

  if (mode === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(trimmed, "i");
    } catch (e) {
      return { hits: [], error: (e as Error).message };
    }
    testFn = (line) => {
      const m = line.match(re);
      if (m && m.index !== undefined) return { start: m.index, end: m.index + m[0].length };
      return null;
    };
  } else if (mode === "fuzzy") {
    const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    testFn = (line) => {
      const lower = line.toLowerCase();
      if (!tokens.every((t) => lower.includes(t))) return null;
      const idx = lower.indexOf(tokens[0]);
      return { start: idx >= 0 ? idx : 0, end: idx >= 0 ? idx + tokens[0].length : 0 };
    };
  } else {
    const needle = trimmed.toLowerCase();
    testFn = (line) => {
      const idx = line.toLowerCase().indexOf(needle);
      return idx >= 0 ? { start: idx, end: idx + needle.length } : null;
    };
  }

  for (const [pageStr, lines] of Object.entries(pageLines)) {
    const page = Number(pageStr);
    lines.forEach((spans, lineIndex) => {
      const lineText = spans.map((s) => s.str).join(" ");
      const range = testFn(lineText);
      if (!range) return;
      hits.push({
        page,
        lineIndex,
        line: lineText.trim(),
        matchStart: range.start,
        matchEnd: range.end,
        boxes: spanBoxesForMatch(spans, range.start, range.end),
      });
    });
  }
  return { hits, error: null };
}

function defaultSchema(): string {
  return JSON.stringify(
    {
      title: "string",
      doi: "string",
      year: "number",
      authors: "string[]",
      abstract: "string",
      keywords: "string[]",
      sample_size: "/n\\s*=\\s*(\\d+)/",
    },
    null,
    2
  );
}

function extractWithSchema(
  schema: Record<string, string>,
  byPage: Record<number, string>
): { result: Record<string, unknown>; trace: Record<string, string> } {
  const allText = Object.values(byPage).join("\n");
  const result: Record<string, unknown> = {};
  const trace: Record<string, string> = {};

  for (const [field, type] of Object.entries(schema)) {
    const lower = field.toLowerCase();
    const isRegexLiteral =
      typeof type === "string" && type.startsWith("/") && type.lastIndexOf("/") > 0;

    if (isRegexLiteral) {
      const lastSlash = type.lastIndexOf("/");
      const pattern = type.slice(1, lastSlash);
      const flags = type.slice(lastSlash + 1) || "i";
      try {
        const re = new RegExp(pattern, flags);
        const m = allText.match(re);
        result[field] = m ? (m[1] ?? m[0]) : null;
        trace[field] = m ? `regex hit @ ${m.index ?? "?"}` : "regex no match";
      } catch (e) {
        result[field] = null;
        trace[field] = `bad regex: ${(e as Error).message}`;
      }
      continue;
    }

    if (/doi/.test(lower)) {
      const m = allText.match(/10\.\d{4,9}\/[^\s"<>]+/);
      result[field] = m?.[0] ?? null;
      trace[field] = m ? "doi pattern hit" : "no doi";
      continue;
    }
    if (/year/.test(lower) || type === "number") {
      const m = allText.match(/\b(19|20)\d{2}\b/);
      result[field] = m ? Number(m[0]) : null;
      trace[field] = m ? "year pattern hit" : "no year";
      continue;
    }
    if (/title/.test(lower)) {
      const p1 = byPage[1] || "";
      const lines = p1
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.split(/\s+/).length >= 4);
      result[field] = lines[0] ?? null;
      trace[field] = lines[0] ? "first long line of p.1" : "no candidate";
      continue;
    }
    if (/author/.test(lower)) {
      const p1 = byPage[1] || "";
      const lines = p1.split("\n").map((s) => s.trim()).filter(Boolean);
      const a = lines.find(
        (l) => /,|\band\b/.test(l) && !/abstract|keywords/i.test(l) && l.length < 400
      );
      result[field] = a
        ? a
            .split(/,|\band\b/)
            .map((s) => s.replace(/\d+|†|‡|\*/g, "").trim())
            .filter((s) => s.length > 1)
        : [];
      trace[field] = a ? "comma/and split heuristic" : "no author line";
      continue;
    }
    if (/abstract/.test(lower)) {
      const m = allText.match(
        /abstract[:\s\n]+([\s\S]{60,2000}?)(?:\n[A-Z][a-z]+\s*\n|introduction|background|methods|results|keywords)/i
      );
      result[field] =
        m?.[1].replace(/\s+/g, " ").trim() ?? null;
      trace[field] = m ? "captured between Abstract and next section" : "not found";
      continue;
    }
    if (/keyword/.test(lower)) {
      const m = allText.match(/keywords?[:\s]+([^\n]{3,300})/i);
      result[field] = m
        ? m[1]
            .split(/[;,·•]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      trace[field] = m ? "split on punctuation" : "no keywords";
      continue;
    }
    if (type === "array" || type.endsWith("[]")) {
      result[field] = [];
      trace[field] = "no heuristic for array field";
      continue;
    }
    result[field] = null;
    trace[field] = "no heuristic";
  }
  return { result, trace };
}

function LeftRail({
  tab,
  setTab,
  pageTexts,
  pageLines,
  pageCount,
  goToPage,
  pdfName,
  onHitsChange,
}: {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  pageTexts: Record<number, string>;
  pageLines: Record<number, TextSpan[][]>;
  pageCount: number;
  goToPage: (p: number) => void;
  pdfName: string;
  onHitsChange: (hits: SearchHit[]) => void;
}) {
  return (
    <aside className="hidden w-[320px] shrink-0 border-r border-border bg-card/40 lg:flex lg:flex-col">
      <div className="flex items-center gap-1 border-b border-border bg-card/60 p-1">
        {([
          { id: "search", label: "Search" },
          { id: "extract", label: "Extract" },
          { id: "off", label: "Hide" },
        ] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded px-2 py-1 text-xs font-mono transition ${
              tab === t.id
                ? "bg-ink text-paper-50 dark:bg-paper-50 dark:text-ink"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "search" && (
        <SearchPanel
          pageLines={pageLines}
          pageCount={pageCount}
          goToPage={goToPage}
          onHitsChange={onHitsChange}
        />
      )}
      {tab === "extract" && (
        <ExtractPanel pageTexts={pageTexts} pdfName={pdfName} />
      )}
      {tab === "off" && (
        <div className="p-3 text-xs text-muted-foreground">Tools hidden.</div>
      )}
    </aside>
  );
}

function SearchPanel({
  pageLines,
  pageCount,
  goToPage,
  onHitsChange,
}: {
  pageLines: Record<number, TextSpan[][]>;
  pageCount: number;
  goToPage: (p: number) => void;
  onHitsChange: (hits: SearchHit[]) => void;
}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>("text");
  const { hits, error } = useMemo(
    () => runSearch(q, mode, pageLines),
    [q, mode, pageLines]
  );
  // Push hits up to App so PdfPage can paint overlays
  useEffect(() => {
    onHitsChange(hits);
  }, [hits, onHitsChange]);
  // Clear when this panel unmounts (tab switched away)
  useEffect(() => () => onHitsChange([]), [onHitsChange]);
  const indexedPages = Object.keys(pageLines).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <p className="font-display text-sm">Search</p>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            indexed {indexedPages}/{pageCount || "—"}
          </span>
        </div>
        <input
          type="text"
          placeholder={
            mode === "regex"
              ? "/regex/ pattern…"
              : mode === "fuzzy"
              ? "loose tokens — any order"
              : "exact substring"
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-brass-500"
        />
        <div className="mt-2 flex gap-1">
          {(["text", "fuzzy", "regex"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded px-2 py-0.5 text-[11px] font-mono transition ${
                mode === m
                  ? "bg-brass-500 text-paper-50"
                  : "border border-border bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {error && (
          <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10px] text-destructive">
            {error}
          </p>
        )}
        {!error && q && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {hits.length} hit{hits.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {hits.length === 0 && q && !error && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No matches.
          </p>
        )}
        <ol className="space-y-1.5">
          {hits.slice(0, 200).map((h, i) => (
            <li key={`${h.page}-${i}`}>
              <button
                type="button"
                onClick={() => goToPage(h.page)}
                className="flex w-full items-start gap-2 rounded border border-transparent px-2 py-1.5 text-left text-[12px] hover:border-border hover:bg-card"
              >
                <span className="mt-0.5 inline-block min-w-[3ch] rounded bg-muted px-1 text-center font-mono text-[10px] text-muted-foreground">
                  p{h.page}
                </span>
                <span className="flex-1 leading-snug">
                  {h.line.length <= 140
                    ? renderLineWithMatch(h.line, h.matchStart, h.matchEnd)
                    : renderLineWithMatch(
                        "…" +
                          h.line.slice(
                            Math.max(0, h.matchStart - 30),
                            Math.min(h.line.length, h.matchEnd + 70)
                          ) +
                          "…",
                        Math.min(h.matchStart, 30) + 1,
                        Math.min(h.matchStart, 30) +
                          1 +
                          (h.matchEnd - h.matchStart)
                      )}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {hits.length > 200 && (
          <p className="px-1 py-2 font-mono text-[10px] text-muted-foreground">
            (showing first 200 of {hits.length})
          </p>
        )}
      </div>
    </div>
  );
}

function renderLineWithMatch(line: string, start: number, end: number) {
  if (end <= start) return line;
  return (
    <>
      {line.slice(0, start)}
      <mark className="rounded bg-amber-200/80 px-0.5">
        {line.slice(start, end)}
      </mark>
      {line.slice(end)}
    </>
  );
}

function ExtractPanel({
  pageTexts,
  pdfName,
}: {
  pageTexts: Record<number, string>;
  pdfName: string;
}) {
  const [schemaText, setSchemaText] = useState<string>(defaultSchema);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<{
    result: Record<string, unknown>;
    trace: Record<string, string>;
  } | null>(null);

  const onExtract = useCallback(() => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaText);
    } catch (e) {
      setError("Schema is not valid JSON: " + (e as Error).message);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError("Schema must be a JSON object: { fieldName: 'string' | 'number' | 'string[]' | '/regex/flags' }");
      return;
    }
    const schema = parsed as Record<string, string>;
    setOutput(extractWithSchema(schema, pageTexts));
  }, [schemaText, pageTexts]);

  const copyResult = useCallback(() => {
    if (!output) return;
    void navigator.clipboard.writeText(JSON.stringify(output.result, null, 2));
  }, [output]);

  const downloadResult = useCallback(() => {
    if (!output) return;
    downloadJson(`${pdfName.replace(/\.pdf$/i, "")}-extract.json`, output.result);
  }, [output, pdfName]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <p className="font-display text-sm">Extract</p>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            schema · paste JSON
          </span>
        </div>
        <textarea
          value={schemaText}
          onChange={(e) => setSchemaText(e.target.value)}
          spellCheck={false}
          rows={9}
          className="w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-snug outline-none focus:border-brass-500"
        />
        <div className="mt-2 flex gap-1">
          <button
            type="button"
            onClick={onExtract}
            className="flex-1 rounded bg-ink px-2 py-1 text-xs text-paper-50 hover:bg-ink-50 dark:bg-paper-50 dark:text-ink dark:hover:bg-paper-200"
          >
            Extract
          </button>
          <button
            type="button"
            onClick={() => setSchemaText(defaultSchema())}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            Reset
          </button>
        </div>
        {error && (
          <p className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[10px] text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!output ? (
          <p className="text-xs text-muted-foreground">
            Paste a JSON schema above and press Extract. Field names trigger
            built-in heuristics for{" "}
            <span className="font-mono">title, doi, year, authors, abstract, keywords</span>.
            Values like{" "}
            <span className="font-mono">"/n\\s*=\\s*(\\d+)/"</span> run as
            literal regex (capture-group 1 if present).
          </p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <p className="font-display text-sm">Result</p>
              <button
                type="button"
                onClick={copyResult}
                className="ml-auto rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-muted"
              >
                Copy JSON
              </button>
              <button
                type="button"
                onClick={downloadResult}
                className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-muted"
              >
                Download
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-[11px] leading-snug">
              {JSON.stringify(output.result, null, 2)}
            </pre>
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
                trace · why each field was chosen
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-border bg-card p-2 font-mono text-[10px] text-muted-foreground">
                {Object.entries(output.trace)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}

function DropHero({ error }: { error: string | null }) {
  return (
    <div className="mx-auto mt-20 max-w-xl text-center">
      <h2 className="font-display text-3xl tracking-tight text-foreground">
        Drop a PDF anywhere on this window
      </h2>
      <p className="mt-3 text-sm text-muted-foreground">
        Or use the <span className="font-medium text-foreground">Open PDF</span>{" "}
        button in the header. Then drag-select on a page to highlight in your
        chosen color. The mini-map on the right shows every mark.
      </p>
      <div className="mx-auto mt-8 flex max-w-sm flex-col gap-2 rounded-md border border-dashed border-brass-300 bg-paper-50/60 p-6 text-xs text-muted-foreground">
        <span className="font-mono">PDF · drag &amp; drop · highlight · export JSON</span>
        <span>No upload — your file stays in this tab.</span>
      </div>
      {error && (
        <p className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default App;
