import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;
const TARGET = "https://www.atelier-alphonse.com";
const TARGET_HOST = "www.atelier-alphonse.com";

const SHOWS = {
  lundi: {
    label: "La Maison des Bluets - Lundi 22 Juin",
    skuId: "69f8bba29c9b17be00b5ba47",
  },
  mardi: {
    label: "La maison des Bluets - Mardi 23 Juin",
    skuId: "69f8be42fc54ab4be1e9fbab",
  },
};

// Rewrite HTML: replace absolute URLs to atelier-alphonse with relative (goes through our proxy)
function rewriteHtml(html, injectScript = "") {
  // Replace absolute links to the target domain with relative paths
  html = html.replace(
    /https?:\/\/www\.atelier-alphonse\.com\//g,
    "/"
  );
  // Also handle protocol-relative
  html = html.replace(
    /\/\/www\.atelier-alphonse\.com\//g,
    "/"
  );
  // Inject script before </body> if provided
  if (injectScript) {
    html = html.replace("</body>", injectScript + "</body>");
  }
  return html;
}

// Rewrite Set-Cookie headers from target to work on our domain
function rewriteCookies(setCookieHeaders) {
  if (!setCookieHeaders) return [];
  const cookies = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  return cookies.map((c) =>
    c
      .replace(/Domain=[^;]+;?\s*/gi, "")
      .replace(/SameSite=[^;]+;?\s*/gi, "SameSite=Lax; ")
      .replace(/;\s*Secure/gi, "") // Remove Secure flag for localhost HTTP
      .replace(/HttpOnly;?\s*/gi, "") // Remove HttpOnly so JS can access if needed
  );
}

// Proxy a request to the target site
async function proxyFetch(urlPath, options = {}) {
  const url = `${TARGET}${urlPath}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Host: TARGET_HOST,
      Referer: `${TARGET}/spectacles`,
      Origin: TARGET,
    },
    redirect: "manual",
  });
  return res;
}

// Read incoming request body
function getBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // === Landing page ===
  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  // === /go/lundi or /go/mardi — the magic route ===
  const goMatch = url.pathname.match(/^\/go\/(lundi|mardi)$/);
  if (goMatch) {
    const showKey = goMatch[1];
    const show = SHOWS[showKey];
    console.log(`[${new Date().toISOString()}] /go/${showKey} — ${show.label}`);

    try {
      // Fetch the spectacles page from the real site
      const pageRes = await proxyFetch("/spectacles", {
        headers: { Cookie: req.headers.cookie || "" },
      });

      let html = await pageRes.text();
      html = rewriteHtml(html);

      // Inject script that auto-clicks the right "Réserver" button
      const autoAddScript = `
        <script>
        (function() {
          // Wait for Webflow Commerce JS to initialize
          function tryAddToCart() {
            var form = document.querySelector('form[data-commerce-sku-id="${show.skuId}"]');
            if (!form) {
              console.log('Form not found yet, retrying...');
              setTimeout(tryAddToCart, 500);
              return;
            }
            // Make the hidden submit button clickable and click it
            var btn = form.querySelector('input[type="submit"]');
            if (btn) {
              btn.style.display = 'block';
              btn.style.position = 'fixed';
              btn.style.top = '-9999px';
              btn.click();
              console.log('Add to cart clicked for ${show.label}');
            } else {
              form.requestSubmit();
            }
          }
          // Show a loading overlay
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:#0a0a0fee;z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:Georgia,serif;color:#f0e6d3';
          overlay.innerHTML = '<div style="text-align:center"><div style="width:40px;height:40px;border:3px solid rgba(196,166,224,0.2);border-top-color:#c4a6e0;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 1.5rem"></div><h2>Ajout au panier...</h2><p style="opacity:0.6;margin-top:0.5rem">${show.label}</p></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
          document.body.appendChild(overlay);

          // Wait for Webflow JS to load, then add to cart
          var checkReady = setInterval(function() {
            if (window.Webflow && document.querySelector('form[data-commerce-sku-id="${show.skuId}"]')) {
              clearInterval(checkReady);
              setTimeout(tryAddToCart, 1000);
            }
          }, 300);

          // Listen for navigation to /checkout (Webflow redirects after add-to-cart)
          var origPush = history.pushState;
          history.pushState = function() {
            origPush.apply(this, arguments);
            if (arguments[2] && arguments[2].includes && arguments[2].includes('checkout')) {
              window.location.href = '/checkout';
            }
          };

          // Also watch for direct navigation
          setTimeout(function() {
            overlay.querySelector('h2').textContent = 'Redirection vers le paiement...';
            window.location.href = '/checkout';
          }, 8000);
        })();
        </script>
      `;

      // Forward cookies from the real site to the client
      const setCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
      const rewritten = rewriteCookies(setCookies);

      const headers = {
        "Content-Type": "text/html; charset=utf-8",
      };
      if (rewritten.length) {
        headers["Set-Cookie"] = rewritten;
      }

      res.writeHead(200, headers);
      res.end(rewriteHtml(html, autoAddScript));
    } catch (err) {
      console.error("Error in /go/:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Erreur: " + err.message);
    }
    return;
  }

  // === Proxy all other requests to the target site ===
  try {
    const body = req.method !== "GET" && req.method !== "HEAD"
      ? await getBody(req)
      : undefined;

    const fetchOptions = {
      method: req.method,
      headers: {
        Cookie: req.headers.cookie || "",
        "Content-Type": req.headers["content-type"] || "",
        Accept: req.headers.accept || "*/*",
        "Accept-Language": req.headers["accept-language"] || "fr",
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      },
      body,
    };

    const proxyRes = await proxyFetch(url.pathname + url.search, fetchOptions);

    // Get response headers
    const contentType = proxyRes.headers.get("content-type") || "";
    const resHeaders = { "Content-Type": contentType };

    // Forward cookies
    const setCookies = proxyRes.headers.getSetCookie ? proxyRes.headers.getSetCookie() : [];
    if (setCookies.length) {
      resHeaders["Set-Cookie"] = rewriteCookies(setCookies);
    }

    // Handle redirects — rewrite Location header
    if ([301, 302, 303, 307, 308].includes(proxyRes.status)) {
      let location = proxyRes.headers.get("location") || "/";
      location = location.replace(TARGET, "");
      resHeaders["Location"] = location;
      res.writeHead(proxyRes.status, resHeaders);
      res.end();
      return;
    }

    // For HTML responses, rewrite URLs
    if (contentType.includes("text/html")) {
      let html = await proxyRes.text();
      html = rewriteHtml(html);
      res.writeHead(proxyRes.status, resHeaders);
      res.end(html);
      return;
    }

    // For everything else, pipe through
    const responseBody = await proxyRes.arrayBuffer();
    res.writeHead(proxyRes.status, resHeaders);
    res.end(Buffer.from(responseBody));
  } catch (err) {
    console.error(`Proxy error for ${url.pathname}:`, err.message);
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`
  🎭 La Maison des Bluets — Serveur pirate
  ==========================================
  http://localhost:${PORT}           → Landing page
  http://localhost:${PORT}/go/lundi  → Auto-réserve Lundi 22
  http://localhost:${PORT}/go/mardi  → Auto-réserve Mardi 23

  Le proxy redirige tout vers ${TARGET}
  Les cookies restent sur notre domaine = panier partageable !
  `);
});
