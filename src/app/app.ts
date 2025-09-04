import { Component, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = 'assets/pdfjs/pdf.worker.min.mjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './home.html',
  styleUrl: './app.css',
})
export class App {
  constructor(private cdr: ChangeDetectorRef) {}
  // Template references for current-page rendering
  @ViewChild('leftCanvas') leftCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('rightCanvas') rightCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('diffCanvas') diffCanvasRef?: ElementRef<HTMLCanvasElement>;

  fileLeft: File | null = null;
  fileRight: File | null = null;

  hasResults = false;
  readyToView = false;

  currentPage = 1;
  maxPages = 0;

  pixelSimilarity = 0; // percentage
  textSimilarity = 0; // percentage

  private leftDoc: any = null;
  private rightDoc: any = null;


  onDragOver(evt: DragEvent) {
    evt.preventDefault();
  }

  async onDrop(evt: DragEvent, side: 'left' | 'right') {
    evt.preventDefault();
    const f = evt.dataTransfer?.files?.[0];
    if (f && f.type === 'application/pdf') {
      if (side === 'left') this.fileLeft = f; else this.fileRight = f;
      this.resetState();
    }
  }

  onFileSelected(evt: Event, side: 'left' | 'right') {
    const input = evt.target as HTMLInputElement;
    const f = input.files?.[0] || null;
    if (f && f.type === 'application/pdf') {
      if (side === 'left') this.fileLeft = f; else this.fileRight = f;
      this.resetState();
    }
  }

  private resetState() {
    this.hasResults = false;
    this.readyToView = false;
    this.currentPage = 1;
    this.maxPages = 0;
    this.pixelSimilarity = 0;
    this.textSimilarity = 0;
    this.leftDoc = null;
    this.rightDoc = null;
  }

  async onCompare() {
    if (!this.fileLeft || !this.fileRight) return;
    // Load PDFs
    const [leftBuf, rightBuf] = await Promise.all([
      this.fileLeft.arrayBuffer(),
      this.fileRight.arrayBuffer(),
    ]);

    const leftTask = getDocument({ data: leftBuf });
    const rightTask = getDocument({ data: rightBuf });
    [this.leftDoc, this.rightDoc] = await Promise.all([leftTask.promise, rightTask.promise]);

    this.maxPages = Math.max(this.leftDoc.numPages || 0, this.rightDoc.numPages || 0);
    this.readyToView = true;

    // Trigger view update so canvases are created before waiting for ViewChilds
    this.cdr.detectChanges();

    // Ensure canvases exist before first render to avoid double-click behavior
    await this.waitForViewReady();
    await this.renderCurrentPage();

    // Compute both similarities across all pages
    const [pixel, text] = await Promise.all([
      this.computePixelSimilarityAllPages(),
      this.computeTextSimilarityAllPages(),
    ]);
    this.pixelSimilarity = pixel;
    this.textSimilarity = text;

    this.hasResults = true;
    // Force view update so the metrics section appears immediately under zoneless CD
    this.cdr.detectChanges();
  }

  async prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      await this.renderCurrentPage();
    }
  }

  async nextPage() {
    if (this.currentPage < this.maxPages) {
      this.currentPage++;
      await this.renderCurrentPage();
    }
  }

  private async renderCurrentPage() {
    if (!this.readyToView) return;
    await this.renderImagePage(this.currentPage);
  }

  private async waitForViewReady(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((res) => setTimeout(res, 0));
      await new Promise<void>((res) => requestAnimationFrame(() => res()));
      if (this.leftCanvasRef?.nativeElement && this.rightCanvasRef?.nativeElement && this.diffCanvasRef?.nativeElement) {
        return;
      }
    }
  }

  private async renderImagePage(pageNum: number) {
    const leftCanvas = this.leftCanvasRef?.nativeElement;
    const rightCanvas = this.rightCanvasRef?.nativeElement;
    const diffCanvas = this.diffCanvasRef?.nativeElement;
    if (!leftCanvas || !rightCanvas || !diffCanvas) return;

    const leftPage = pageNum <= (this.leftDoc?.numPages || 0)
      ? await this.leftDoc.getPage(pageNum)
      : null;
    const rightPage = pageNum <= (this.rightDoc?.numPages || 0)
      ? await this.rightDoc.getPage(pageNum)
      : null;

    const targetWidth = 700;

    const renderPageTo = async (page: any, canvas: HTMLCanvasElement) => {
      const ctx = canvas.getContext('2d')!;
      if (!page) {
        // blank page
        canvas.width = targetWidth;
        canvas.height = Math.floor(targetWidth * 1.414); // A4-ish
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return { width: canvas.width, height: canvas.height };
      }
      const viewport0 = page.getViewport({ scale: 1 });
      const scale = targetWidth / viewport0.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const renderContext = { canvasContext: ctx, viewport };
      await page.render(renderContext).promise;
      return { width: canvas.width, height: canvas.height };
    };

    const leftSize = await renderPageTo(leftPage, leftCanvas);
    const rightSize = await renderPageTo(rightPage, rightCanvas);

    // Make diffCanvas match rightCanvas size
    diffCanvas.width = rightSize.width;
    diffCanvas.height = rightSize.height;

    // Compute and draw diff overlay relative to right canvas size
    const overlayCtx = diffCanvas.getContext('2d')!;
    overlayCtx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);

    // For comparison, we need same dimensions. Create offscreen canvases at common size.
    const W = Math.min(leftSize.width, rightSize.width);
    const H = Math.min(leftSize.height, rightSize.height);
    if (W === 0 || H === 0) return;

    const offL = document.createElement('canvas');
    const offR = document.createElement('canvas');
    offL.width = W; offL.height = H;
    offR.width = W; offR.height = H;
    const offLCtx = offL.getContext('2d')!;
    const offRCtx = offR.getContext('2d')!;

    offLCtx.drawImage(leftCanvas, 0, 0, W, H);
    offRCtx.drawImage(rightCanvas, 0, 0, W, H);

    const imgL = offLCtx.getImageData(0, 0, W, H);
    const imgR = offRCtx.getImageData(0, 0, W, H);

    const diff = overlayCtx.createImageData(W, H);
    const dataL = imgL.data;
    const dataR = imgR.data;
    const dataD = diff.data;

    for (let i = 0; i < dataL.length; i += 4) {
      const dr = dataL[i] - dataR[i];
      const dg = dataL[i + 1] - dataR[i + 1];
      const db = dataL[i + 2] - dataR[i + 2];
      const da = dataL[i + 3] - dataR[i + 3];
      const dist = Math.abs(dr) + Math.abs(dg) + Math.abs(db) + Math.abs(da);
      if (dist > 60) {
        dataD[i] = 255; // red
        dataD[i + 1] = 0;
        dataD[i + 2] = 0;
        dataD[i + 3] = 150; // semi-transparent
      } else {
        dataD[i] = 0;
        dataD[i + 1] = 0;
        dataD[i + 2] = 0;
        dataD[i + 3] = 0;
      }
    }

    // Draw diff overlay scaled to right canvas size
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d')!.putImageData(diff, 0, 0);
    overlayCtx.drawImage(tmp, 0, 0, rightSize.width, rightSize.height);
  }


  private async computePixelSimilarityAllPages(): Promise<number> {
    let totalPixels = 0;
    let diffPixels = 0;
    const targetWidth = 300; // smaller for performance when aggregating

    for (let p = 1; p <= this.maxPages; p++) {
      const [leftPage, rightPage] = await Promise.all([
        p <= (this.leftDoc?.numPages || 0) ? this.leftDoc.getPage(p) : null,
        p <= (this.rightDoc?.numPages || 0) ? this.rightDoc.getPage(p) : null,
      ]);

      const renderToOff = async (page: any) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        if (!page) {
          canvas.width = targetWidth;
          canvas.height = Math.floor(targetWidth * 1.414);
          ctx.fillStyle = '#111';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          return canvas;
        }
        const viewport0 = page.getViewport({ scale: 1 });
        const scale = targetWidth / viewport0.width;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        return canvas;
      };

      const [cL, cR] = await Promise.all([
        renderToOff(leftPage),
        renderToOff(rightPage),
      ]);

      const W = Math.min(cL.width, cR.width);
      const H = Math.min(cL.height, cR.height);
      if (W === 0 || H === 0) continue;

      const offL = document.createElement('canvas');
      const offR = document.createElement('canvas');
      offL.width = W; offL.height = H;
      offR.width = W; offR.height = H;
      const ctxL = offL.getContext('2d')!;
      const ctxR = offR.getContext('2d')!;
      ctxL.drawImage(cL, 0, 0, W, H);
      ctxR.drawImage(cR, 0, 0, W, H);

      const imgL = ctxL.getImageData(0, 0, W, H).data;
      const imgR = ctxR.getImageData(0, 0, W, H).data;

      totalPixels += W * H;
      for (let i = 0; i < imgL.length; i += 4) {
        const dr = imgL[i] - imgR[i];
        const dg = imgL[i + 1] - imgR[i + 1];
        const db = imgL[i + 2] - imgR[i + 2];
        const da = imgL[i + 3] - imgR[i + 3];
        const dist = Math.abs(dr) + Math.abs(dg) + Math.abs(db) + Math.abs(da);
        if (dist > 60) diffPixels++;
      }
    }

    if (totalPixels === 0) return 100;
    const similarity = 100 * (1 - diffPixels / totalPixels);
    return Math.max(0, Math.min(100, similarity));
  }

  private async computeTextSimilarityAllPages(): Promise<number> {
    let commonCount = 0;
    let totalCount = 0;

    for (let p = 1; p <= this.maxPages; p++) {
      const lt = await this.extractPageText(this.leftDoc, p);
      const rt = await this.extractPageText(this.rightDoc, p);
      const lTokens = this.tokenize(lt);
      const rTokens = this.tokenize(rt);
      const lcs = this.lcsLength(lTokens, rTokens);
      commonCount += lcs;
      totalCount += lTokens.length + rTokens.length;
    }

    if (totalCount === 0) return 100;
    const similarity = (2 * commonCount) / totalCount * 100;
    return Math.max(0, Math.min(100, similarity));
  }

  private async extractPageText(doc: any, pageNum: number): Promise<string> {
    const num = doc?.numPages || 0;
    if (pageNum > num || pageNum < 1) return '';
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const strings: string[] = [];
    for (const item of content.items as any[]) {
      const s = (item as any).str;
      strings.push(s);
    }
    return strings.join(' ');
  }

  private tokenize(text: string): string[] {
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  private lcsLength(a: string[], b: string[]): number {
    const m = a.length, n = b.length;
    const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
  }

  private lcsIndices(a: string[], b: string[]): { leftKeep: Set<number>; rightKeep: Set<number> } {
    const m = a.length, n = b.length;
    const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const leftKeep = new Set<number>();
    const rightKeep = new Set<number>();
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        leftKeep.add(i - 1);
        rightKeep.add(j - 1);
        i--; j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return { leftKeep, rightKeep };
  }

  private tokensToHtml(tokens: string[], keep: Set<number>, cls: 'add' | 'del'): string {
    const parts: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = this.escapeHtml(tokens[i]);
      if (keep.has(i)) {
        parts.push(`<span>${t}</span>`);
      } else {
        parts.push(`<span class="${cls}">${t}</span>`);
      }
    }
    return parts.join(' ');
  }

  private escapeHtml(s: string) {
    return s.replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  }
}
