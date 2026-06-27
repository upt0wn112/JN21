const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PHOTO_DIR = path.join(ROOT, "01_ITEM_PHOTOS");
const LOGO_DIR = path.join(ROOT, "02_Logo");
const PUBLIC_DIR = path.join(ROOT, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "products.sqlite");
const CSV_PATH = path.join(ROOT, "products.csv");
const PRODUCT_DATA_PATH = path.join(PUBLIC_DIR, "js", "products-data.js");
const PORT = Number(process.env.PORT || 3000);

const IMAGE_EXTENSIONS = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

fs.mkdirSync(GENERATED_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    item_name TEXT NOT NULL DEFAULT '',
    item_number TEXT NOT NULL DEFAULT '',
    item_price TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function resolveSharp() {
  const candidates = [
    process.env.SHARP_MODULE_PATH,
    path.join(ROOT, "node_modules", "sharp"),
    "C:/Users/lizwa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Keep looking; the app can still serve existing generated images.
    }
  }
  return null;
}

const sharp = resolveSharp();

function photoFiles() {
  if (!fs.existsSync(PHOTO_DIR)) return [];
  return fs
    .readdirSync(PHOTO_DIR)
    .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function generatedName(filename) {
  const parsed = path.parse(filename);
  return `${parsed.name}.jpg`;
}

function filenameToProduct(filename) {
  const parsed = path.parse(filename).name;
  const [itemNumber, ...nameParts] = parsed.split("_");
  return {
    filename,
    itemName: nameParts.join(" ").trim(),
    itemNumber: itemNumber || "",
    itemPrice: ""
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((item) => item.some((value) => value.trim()));
}

function csvEscape(value) {
  const text = String(value || "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function readCsvProducts() {
  if (!fs.existsSync(CSV_PATH)) return new Map();
  const rows = parseCsv(fs.readFileSync(CSV_PATH, "utf8"));
  const [header, ...body] = rows;
  if (!header) return new Map();

  const indexes = Object.fromEntries(header.map((name, index) => [name.trim().toLowerCase(), index]));
  const productsByFilename = new Map();
  for (const row of body) {
    const filename = String(row[indexes.filename] || "").trim();
    if (!filename) continue;
    productsByFilename.set(filename, {
      filename,
      itemName: String(row[indexes.item_name] || "").trim(),
      itemNumber: String(row[indexes.item_number] || "").trim(),
      itemPrice: String(row[indexes.item_price] || "").trim()
    });
  }
  return productsByFilename;
}

function writeCsvProducts(productRows) {
  const rows = [["filename", "item_name", "item_number", "item_price"]];
  for (const product of productRows) {
    rows.push([product.filename, product.itemName, product.itemNumber, product.itemPrice]);
  }
  const csv = `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
  fs.writeFileSync(CSV_PATH, csv, "utf8");
}

function writeProductData(productRows) {
  const productsByFilename = Object.fromEntries(productRows.map((product) => [
    product.filename,
    {
      itemName: product.itemName,
      itemNumber: product.itemNumber,
      itemPrice: product.itemPrice
    }
  ]));
  fs.writeFileSync(
    PRODUCT_DATA_PATH,
    `window.PRODUCT_DATA = ${JSON.stringify(productsByFilename, null, 2)};\n`,
    "utf8"
  );
}

function dbProducts() {
  return new Map(db
    .prepare("SELECT filename, item_name, item_number, item_price FROM products")
    .all()
    .map((row) => [row.filename, {
      filename: row.filename,
      itemName: row.item_name,
      itemNumber: row.item_number,
      itemPrice: row.item_price
    }]));
}

function catalogRows() {
  const csvRows = readCsvProducts();
  const dbRows = dbProducts();
  return photoFiles().map((filename) => {
    const fallback = filenameToProduct(filename);
    const csvRow = csvRows.get(filename) || {};
    const dbRow = dbRows.get(filename) || {};
    return {
      filename,
      itemName: csvRow.itemName || dbRow.itemName || fallback.itemName,
      itemNumber: csvRow.itemNumber || dbRow.itemNumber || fallback.itemNumber,
      itemPrice: csvRow.itemPrice || dbRow.itemPrice || fallback.itemPrice
    };
  });
}

function upsertDbProduct(product) {
  db.prepare(`
    INSERT INTO products (filename, item_name, item_number, item_price, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(filename) DO UPDATE SET
      item_name = excluded.item_name,
      item_number = excluded.item_number,
      item_price = excluded.item_price,
      updated_at = CURRENT_TIMESTAMP
  `).run(product.filename, product.itemName, product.itemNumber, product.itemPrice);
}

function saveCatalog(productRows) {
  writeCsvProducts(productRows);
  writeProductData(productRows);
  for (const product of productRows) {
    upsertDbProduct(product);
  }
}

function seedDatabase() {
  const productRows = catalogRows();
  const keep = new Set(productRows.map((product) => product.filename));
  const existingRows = db.prepare("SELECT filename FROM products").all();
  const remove = db.prepare("DELETE FROM products WHERE filename = ?");
  for (const row of existingRows) {
    if (!keep.has(row.filename)) remove.run(row.filename);
  }

  for (const product of productRows) {
    upsertDbProduct(product);
  }
  writeCsvProducts(productRows);
  writeProductData(productRows);
}

async function generateImages() {
  if (!sharp) {
    console.warn("Sharp was not available. Generated browser-friendly images were not updated.");
    return;
  }

  for (const filename of photoFiles()) {
    const source = path.join(PHOTO_DIR, filename);
    const target = path.join(GENERATED_DIR, generatedName(filename));
    const sourceTime = fs.statSync(source).mtimeMs;
    const targetTime = fs.existsSync(target) ? fs.statSync(target).mtimeMs : 0;
    if (targetTime >= sourceTime) continue;

    try {
      await sharp(source)
        .rotate()
        .resize(900, 900, { fit: "cover", position: "centre" })
        .jpeg({ quality: 86, mozjpeg: true })
        .toFile(target);
    } catch (error) {
      console.warn(`Could not convert ${filename}: ${error.message.split("\n")[0]}`);
    }
  }
}

function products() {
  seedDatabase();
  return catalogRows().map((product) => ({
    ...product,
    imageUrl: imageUrl(product.filename)
  }));
}

function imageUrl(filename) {
  const generated = path.join(GENERATED_DIR, generatedName(filename));
  if (fs.existsSync(generated) && fs.statSync(generated).size > 0) {
    return `/generated/${encodeURIComponent(generatedName(filename))}`;
  }
  return `/photos/${encodeURIComponent(filename)}`;
}

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(safePath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function servePhoto(res, pathname) {
  const filename = decodeURIComponent(pathname.slice("/photos/".length));
  if (!photoFiles().includes(filename)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const filePath = path.join(PHOTO_DIR, filename);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function serveLogo(res, pathname) {
  const filename = decodeURIComponent(pathname.slice("/logo/".length));
  const filePath = path.normalize(path.join(LOGO_DIR, filename));
  if (!filePath.startsWith(LOGO_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/products") {
    jsonResponse(res, 200, { products: products() });
    return true;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/products/")) {
    const filename = decodeURIComponent(url.pathname.slice("/api/products/".length));
    if (!photoFiles().includes(filename)) {
      jsonResponse(res, 404, { error: "Photo not found." });
      return true;
    }

    const body = await readJson(req);
    const itemName = String(body.itemName || "").trim();
    const itemNumber = String(body.itemNumber || "").trim();
    const itemPrice = String(body.itemPrice || "").trim();

    const productRows = catalogRows().map((product) => product.filename === filename
      ? { ...product, itemName, itemNumber, itemPrice }
      : product);
    saveCatalog(productRows);

    jsonResponse(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function start() {
  seedDatabase();
  await generateImages();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/api/") && await handleApi(req, res, url)) return;
      if (url.pathname.startsWith("/photos/")) {
        servePhoto(res, url.pathname);
        return;
      }
      if (url.pathname.startsWith("/logo/")) {
        serveLogo(res, url.pathname);
        return;
      }
      serveStatic(res, url.pathname);
    } catch (error) {
      jsonResponse(res, 500, { error: error.message });
    }
  });

  server.listen(PORT, () => {
    console.log(`Product gallery running at http://localhost:${PORT}`);
    console.log(`Admin page running at http://localhost:${PORT}/admin.html`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
