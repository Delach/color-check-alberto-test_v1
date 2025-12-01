import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import Jimp from "jimp";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb" }));

// Multer para upload de imágenes
const upload = multer({ storage: multer.memoryStorage() });

// ============================================
// COLOR ANALYSIS UTILITIES
// ============================================

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface ColorAnalysis {
  hex: string;
  rgb: RGB;
  luminance: number;
  percentage: number;
}

interface ContrastAnalysis {
  foreground: string;
  background: string;
  ratio: number;
  wcagAA: boolean;
  wcagAAA: boolean;
  originalRatio: number;
}

interface ColorCorrectionResult {
  original: {
    hex: string;
    rgb: RGB;
  };
  corrected: {
    hex: string;
    rgb: RGB;
    oklch: string;
  };
  contrast: ContrastAnalysis;
  preview: {
    background: string;
    foreground: string;
    beforeHex: string;
    afterHex: string;
  };
}

// Convertir HEX a RGB
function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) throw new Error(`Invalid hex color: ${hex}`);
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

// Convertir RGB a HEX
function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
      .toUpperCase()
  );
}

// Calcular luminancia relativa (WCAG formula)
function calculateLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

// Calcular contraste WCAG
function calculateContrast(fgHex: string, bgHex: string): number {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);

  const fgLum = calculateLuminance(fg.r, fg.g, fg.b);
  const bgLum = calculateLuminance(bg.r, bg.g, bg.b);

  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);

  return (lighter + 0.05) / (darker + 0.05);
}

// RGB a OKLCH (simplificado)
function rgbToOklch(r: number, g: number, b: number): string {
  // Normalizar RGB
  let [rs, gs, bs] = [r, g, b].map((c) => c / 255);

  // RGB lineal
  [rs, gs, bs] = [rs, gs, bs].map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );

  // XYZ
  const x = rs * 0.4124 + gs * 0.3576 + bs * 0.1805;
  const y = rs * 0.2126 + gs * 0.7152 + bs * 0.0722;
  const z = rs * 0.0193 + gs * 0.1192 + bs * 0.9505;

  // Lab
  const xn = x / 0.95047;
  const yn = y / 1.0;
  const zn = z / 1.08883;

  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16) / 116;

  const l = 116 * f(yn) - 16;
  const a = 500 * (f(xn) - f(yn));
  const b_val = 200 * (f(yn) - f(zn));

  // LCH
  const c = Math.sqrt(a * a + b_val * b_val);
  const h = (Math.atan2(b_val, a) * 180) / Math.PI;

  return `oklch(${(l / 100).toFixed(2)} ${(c / 150).toFixed(3)} ${(h + 360) % 360})`;
}

// Sugerir color accesible ajustando luminosidad (OKLCH)
function suggestAccessibleColor(
  originalHex: string,
  targetRatio: number = 7.0,
  bgHex: string = "#FFFFFF"
): string {
  const original = hexToRgb(originalHex);
  let best = originalHex;
  let bestRatio = calculateContrast(originalHex, bgHex);

  // Intentar diferentes ajustes de luminosidad
  for (let brightness = 0; brightness <= 255; brightness += 5) {
    const adjusted = rgbToHex(
      Math.max(0, original.r - brightness),
      Math.max(0, original.g - brightness),
      Math.max(0, original.b - brightness)
    );

    const ratio = calculateContrast(adjusted, bgHex);

    if (ratio >= targetRatio) {
      return adjusted;
    }

    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = adjusted;
    }
  }

  return best;
}

// Extraer colores dominantes de imagen
async function extractDominantColors(imageBuffer: Buffer): Promise<ColorAnalysis[]> {
  const image = await Jimp.read(imageBuffer);

  // Redimensionar para análisis rápido
  image.resize({ w: 100, h: 100 });

  const colorMap = new Map<string, number>();

  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y) {
    const hex = rgbToHex(this.bitmap.data[0], this.bitmap.data[1], this.bitmap.data[2]);
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  });

  // Ordenar por frecuencia
  const sorted = Array.from(colorMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10) // Top 10 colores
    .map(([hex, count], index, array) => {
      const rgb = hexToRgb(hex);
      return {
        hex,
        rgb,
        luminance: calculateLuminance(rgb.r, rgb.g, rgb.b),
        percentage: Math.round((count / array.length) * 100),
      };
    });

  return sorted;
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Endpoint SSE para análisis en tiempo real
app.get("/api/analyze-stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Enviar evento de conexión
  res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);

  // Simular análisis
  const colors = ["#FFD900", "#7AC943", "#000000", "#E8E8E8"];
  let index = 0;

  const interval = setInterval(() => {
    if (index >= colors.length) {
      res.write(`data: ${JSON.stringify({ status: "complete" })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }

    const color = colors[index];
    const contrast = calculateContrast(color, "#FFFFFF");

    res.write(
      `data: ${JSON.stringify({
        color,
        contrast: parseFloat(contrast.toFixed(2)),
        wcagAA: contrast >= 4.5,
        wcagAAA: contrast >= 7.0,
      })}\n\n`
    );

    index++;
  }, 500);

  // Limpiar al desconectar
  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});

// Endpoint POST para análisis de colores
app.post("/api/analyze-colors", express.json({ limit: "50mb" }), (req: Request, res: Response) => {
  try {
    const { colors } = req.body;

    if (!colors || !Array.isArray(colors)) {
      return res.status(400).json({ error: "colors array required" });
    }

    const results: ColorCorrectionResult[] = colors.map((color: string) => {
      const ratio = calculateContrast(color, "#FFFFFF");
      const corrected = suggestAccessibleColor(color, 7.0, "#FFFFFF");
      const correctedRgb = hexToRgb(corrected);

      return {
        original: {
          hex: color,
          rgb: hexToRgb(color),
        },
        corrected: {
          hex: corrected,
          rgb: correctedRgb,
          oklch: rgbToOklch(correctedRgb.r, correctedRgb.g, correctedRgb.b),
        },
        contrast: {
          foreground: color,
          background: "#FFFFFF",
          ratio: parseFloat(ratio.toFixed(2)),
          wcagAA: ratio >= 4.5,
          wcagAAA: ratio >= 7.0,
          originalRatio: parseFloat(ratio.toFixed(2)),
        },
        preview: {
          background: "#FFFFFF",
          foreground: color,
          beforeHex: color,
          afterHex: corrected,
        },
      };
    });

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      results,
      summary: {
        totalColors: colors.length,
        passAAA: results.filter((r) => r.contrast.wcagAAA).length,
        failCount: results.filter((r) => !r.contrast.wcagAAA).length,
      },
    });
  } catch (error) {
    console.error("Error analyzing colors:", error);
    res.status(500).json({ error: "Failed to analyze colors", details: String(error) });
  }
});

// Endpoint POST para análisis de imagen
app.post("/api/analyze-image", upload.single("image"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file required" });
    }

    const colors = await extractDominantColors(req.file.buffer);

    // Analizar contraste de cada color con fondo blanco
    const analysis = colors.map((color) => {
      const contrast = calculateContrast(color.hex, "#FFFFFF");
      const corrected = suggestAccessibleColor(color.hex, 7.0, "#FFFFFF");

      return {
        ...color,
        contrast: {
          ratio: parseFloat(contrast.toFixed(2)),
          wcagAA: contrast >= 4.5,
          wcagAAA: contrast >= 7.0,
        },
        corrected: {
          hex: corrected,
          contrast: parseFloat(calculateContrast(corrected, "#FFFFFF").toFixed(2)),
          wcagAA: calculateContrast(corrected, "#FFFFFF") >= 4.5,
          wcagAAA: calculateContrast(corrected, "#FFFFFF") >= 7.0,
        },
      };
    });

    res.json({
      status: "success",
      timestamp: new Date().toISOString(),
      dominantColors: analysis,
      summary: {
        totalColorsAnalyzed: analysis.length,
        wcagCompliant: analysis.filter((c) => c.contrast.wcagAAA).length,
        needsCorrection: analysis.filter((c) => !c.contrast.wcagAAA).length,
      },
    });
  } catch (error) {
    console.error("Error analyzing image:", error);
    res.status(500).json({ error: "Failed to analyze image", details: String(error) });
  }
});

// Endpoint POST para análisis de sitio web
app.post("/api/analyze-website", express.json(), async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "url required" });
    }

    // Fetch HTML content
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(400).json({ error: `Failed to fetch URL: ${response.statusText}` });
    }

    const html = await response.text();

    // Extract hex colors using regex
    const hexRegex = /#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})\b/g;
    const matches = html.match(hexRegex) || [];

    // Normalize and count colors
    const colorMap = new Map<string, number>();
    matches.forEach(hex => {
      const normalized = hex.toUpperCase();
      // Expand 3-digit hex to 6-digit
      const full = normalized.length === 4
        ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
        : normalized;
      colorMap.set(full, (colorMap.get(full) || 0) + 1);
    });

    // Get top colors by frequency
    const topColors = Array.from(colorMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([color]) => color);

    if (topColors.length === 0) {
      return res.status(400).json({ error: "No colors found on this website" });
    }

    // Analyze the colors
    const analysis = topColors.map((color: string) => {
      const ratio = calculateContrast(color, "#FFFFFF");
      const corrected = suggestAccessibleColor(color, 7.0, "#FFFFFF");
      const correctedRgb = hexToRgb(corrected);

      return {
        original: { hex: color, rgb: hexToRgb(color) },
        corrected: { hex: corrected, rgb: correctedRgb, oklch: rgbToOklch(correctedRgb.r, correctedRgb.g, correctedRgb.b) },
        contrast: { foreground: color, background: "#FFFFFF", ratio: parseFloat(ratio.toFixed(2)), wcagAA: ratio >= 4.5, wcagAAA: ratio >= 7.0, originalRatio: parseFloat(ratio.toFixed(2)) }
      };
    });

    res.json({
      status: "success",
      url,
      results: analysis,
      summary: { totalColors: analysis.length, passAAA: analysis.filter(r => r.contrast.wcagAAA).length },
      ui_ref: "ui://widget/color-analyzer.html",
      ui_url: `${req.protocol}://${req.get("host")}/widgets/color-analyzer.html?colors=${encodeURIComponent(topColors.join(","))}`
    });
  } catch (error) {
    console.error("Error analyzing website:", error);
    res.status(500).json({ error: "Failed to analyze website", details: String(error) });
  }
});

// Endpoint para simular deficiencia visual
app.post("/api/simulate-deficiency", express.json(), (req: Request, res: Response) => {
  try {
    const { color, deficiencyType } = req.body;

    if (!color || !deficiencyType) {
      return res.status(400).json({ error: "color and deficiencyType required" });
    }

    const rgb = hexToRgb(color);
    let simulated: RGB;

    switch (deficiencyType) {
      case "protanopia":
        simulated = {
          r: Math.round(rgb.r * 0.567 + rgb.g * 0.433),
          g: Math.round(rgb.r * 0.558 + rgb.g * 0.442),
          b: Math.round(rgb.b * 0.242),
        };
        break;
      case "deuteranopia":
        simulated = {
          r: Math.round(rgb.r * 0.625 + rgb.g * 0.375),
          g: Math.round(rgb.r * 0.7 + rgb.g * 0.3),
          b: Math.round(rgb.b * 0.3),
        };
        break;
      case "tritanopia":
        simulated = {
          r: Math.round(rgb.r * 0.95 + rgb.b * 0.05),
          g: Math.round(rgb.g * 0.433 + rgb.b * 0.567),
          b: Math.round(rgb.g * 0.475 + rgb.b * 0.525),
        };
        break;
      case "achromatopsia":
        const gray = Math.round(rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114);
        simulated = { r: gray, g: gray, b: gray };
        break;
      default:
        return res.status(400).json({ error: "Invalid deficiency type" });
    }

    res.json({
      original: color,
      deficiencyType,
      simulated: rgbToHex(simulated.r, simulated.g, simulated.b),
      rgb: {
        original: rgb,
        simulated,
      },
    });
  } catch (error) {
    console.error("Error simulating deficiency:", error);
    res.status(500).json({ error: "Failed to simulate deficiency", details: String(error) });
  }
});

// ============================================
// MCP / JSON-RPC 2.0 compatibility endpoint
// ============================================
app.post("/mcp", express.json({ limit: "5mb" }), async (req: Request, res: Response) => {
  const body = req.body;

  if (!body || body.jsonrpc !== "2.0" || !body.method) {
    return res.status(400).json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
  }

  const id = body.id ?? null;

  try {
    let result: any = null;

    switch (body.method) {
      // Task methods removed


      case "analyze_colors": {
        const params = body.params || {};
        const colors: string[] = params.colors || [];

        if (!Array.isArray(colors) || colors.length === 0) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "colors array required" } });
        }

        const results = colors.map((color: string) => {
          const ratio = calculateContrast(color, "#FFFFFF");
          const corrected = suggestAccessibleColor(color, 7.0, "#FFFFFF");
          const correctedRgb = hexToRgb(corrected);

          return {
            original: { hex: color, rgb: hexToRgb(color) },
            corrected: { hex: corrected, rgb: correctedRgb, oklch: rgbToOklch(correctedRgb.r, correctedRgb.g, correctedRgb.b) },
            contrast: { foreground: color, background: "#FFFFFF", ratio: parseFloat(ratio.toFixed(2)), wcagAA: ratio >= 4.5, wcagAAA: ratio >= 7.0, originalRatio: parseFloat(ratio.toFixed(2)) }
          };
        });

        result = {
          status: "success",
          results,
          summary: { totalColors: results.length },
          ui_ref: "ui://widget/color-analyzer.html",
          ui_url: `${req.protocol}://${req.get("host")}/widgets/color-analyzer.html?colors=${encodeURIComponent(colors.join(","))}`
        };
        break;
      }

      case "analyze_image": {
        const params = body.params || {};
        const imageBase64 = params.imageBase64;

        if (!imageBase64) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "imageBase64 param required" } });
        }

        const buffer = Buffer.from(imageBase64, "base64");
        const colors = await extractDominantColors(buffer);

        const analysis = colors.map((color) => {
          const contrast = calculateContrast(color.hex, "#FFFFFF");
          const corrected = suggestAccessibleColor(color.hex, 7.0, "#FFFFFF");

          return {
            ...color,
            contrast: { ratio: parseFloat(contrast.toFixed(2)), wcagAA: contrast >= 4.5, wcagAAA: contrast >= 7.0 },
            corrected: { hex: corrected, contrast: parseFloat(calculateContrast(corrected, "#FFFFFF").toFixed(2)), wcagAAA: calculateContrast(corrected, "#FFFFFF") >= 7.0 }
          };
        });

        result = {
          status: "success",
          dominantColors: analysis,
          summary: { totalColorsAnalyzed: analysis.length },
          ui_ref: "ui://widget/color-analyzer.html",
          ui_url: `${req.protocol}://${req.get("host")}/widgets/color-analyzer.html?colors=${encodeURIComponent(analysis.map(c => c.hex).join(","))}`
        };
        break;
      }

      case "analyze_website": {
        const params = body.params || {};
        const { url } = params;

        if (!url) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "url param required" } });
        }

        try {
          // Fetch HTML content
          const response = await fetch(url);
          if (!response.ok) {
            return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Failed to fetch URL: ${response.statusText}` } });
          }

          const html = await response.text();

          // Extract hex colors using regex
          const hexRegex = /#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})\b/g;
          const matches = html.match(hexRegex) || [];

          // Normalize and count colors
          const colorMap = new Map<string, number>();
          matches.forEach(hex => {
            const normalized = hex.toUpperCase();
            // Expand 3-digit hex to 6-digit
            const full = normalized.length === 4
              ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
              : normalized;
            colorMap.set(full, (colorMap.get(full) || 0) + 1);
          });

          // Get top colors by frequency
          const topColors = Array.from(colorMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([color]) => color);

          if (topColors.length === 0) {
            return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "No colors found on this website" } });
          }

          // Analyze the colors
          const analysis = topColors.map((color: string) => {
            const ratio = calculateContrast(color, "#FFFFFF");
            const corrected = suggestAccessibleColor(color, 7.0, "#FFFFFF");
            const correctedRgb = hexToRgb(corrected);

            return {
              original: { hex: color, rgb: hexToRgb(color) },
              corrected: { hex: corrected, rgb: correctedRgb, oklch: rgbToOklch(correctedRgb.r, correctedRgb.g, correctedRgb.b) },
              contrast: { foreground: color, background: "#FFFFFF", ratio: parseFloat(ratio.toFixed(2)), wcagAA: ratio >= 4.5, wcagAAA: ratio >= 7.0, originalRatio: parseFloat(ratio.toFixed(2)) }
            };
          });

          result = {
            status: "success",
            url,
            results: analysis,
            summary: { totalColors: analysis.length, passAAA: analysis.filter(r => r.contrast.wcagAAA).length },
            ui_ref: "ui://widget/color-analyzer.html",
            ui_url: `${req.protocol}://${req.get("host")}/widgets/color-analyzer.html?colors=${encodeURIComponent(topColors.join(","))}`
          };
        } catch (error) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Failed to analyze website: ${String(error)}` } });
        }
        break;
      }

      case "simulate_deficiency": {
        const params = body.params || {};
        const { color, deficiencyType } = params;

        if (!color || !deficiencyType) {
          return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "color and deficiencyType required" } });
        }

        const rgb = hexToRgb(color);
        let simulated: RGB;

        switch (deficiencyType) {
          case "protanopia":
            simulated = { r: Math.round(rgb.r * 0.567 + rgb.g * 0.433), g: Math.round(rgb.r * 0.558 + rgb.g * 0.442), b: Math.round(rgb.b * 0.242) };
            break;
          case "deuteranopia":
            simulated = { r: Math.round(rgb.r * 0.625 + rgb.g * 0.375), g: Math.round(rgb.r * 0.7 + rgb.g * 0.3), b: Math.round(rgb.b * 0.3) };
            break;
          case "tritanopia":
            simulated = { r: Math.round(rgb.r * 0.95 + rgb.b * 0.05), g: Math.round(rgb.g * 0.433 + rgb.b * 0.567), b: Math.round(rgb.g * 0.475 + rgb.b * 0.525) };
            break;
          case "achromatopsia":
            const gray = Math.round(rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114);
            simulated = { r: gray, g: gray, b: gray };
            break;
          default:
            return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid deficiency type" } });
        }

        result = { original: color, deficiencyType, simulated: rgbToHex(simulated.r, simulated.g, simulated.b), rgb: { original: rgb, simulated } };
        break;
      }

      default:
        return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }

    return res.json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    console.error("MCP handler error:", error);
    return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } });
  }
});

// Serve small static widget templates used by MCP UI refs
app.use("/widgets", express.static(join(__dirname, "../public/widgets")));

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Small helper endpoints used by widget templates


app.get('/api/example-colors', (req: Request, res: Response) => {
  res.json({ colors: ['#FF0000', '#00FF00', '#0000FF', '#FFD900'] });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Color Accessibility Server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoints:`);
  console.log(`  GET  /health`);
  console.log(`  GET  /api/analyze-stream`);
  console.log(`  POST /api/analyze-colors`);
  console.log(`  POST /api/analyze-image`);
  console.log(`  POST /api/simulate-deficiency`);
});

export default app;
