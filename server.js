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

      // Inject script that auto-adds to cart via GraphQL (same as Webflow's own mechanism)
      const autoAddScript = `
        <script>
        (function() {
          var SKU_ID = "${show.skuId}";
          var LABEL = "${show.label}";

          // Show loading overlay
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:#0a0a0fee;z-index:99999;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:Georgia,serif;color:#f0e6d3';
          overlay.innerHTML = '<div style="text-align:center" id="ol-content"><div style="width:40px;height:40px;border:3px solid rgba(196,166,224,0.2);border-top-color:#c4a6e0;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 1.5rem"></div><h2 id="ol-title">Ajout au panier...</h2><p style="opacity:0.6;margin-top:0.5rem">' + LABEL + '</p><p id="ol-debug" style="font-size:0.7rem;opacity:0.3;margin-top:1rem;font-family:monospace"></p></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
          document.body.appendChild(overlay);

          var debug = document.getElementById('ol-debug');
          var title = document.getElementById('ol-title');

          function log(msg) {
            console.log('[PIRATE]', msg);
            if (debug) debug.textContent = msg;
          }

          // Method 1: Direct GraphQL call (same as Webflow does internally)
          function addViaGraphQL() {
            log('Tentative GraphQL directe...');
            fetch('/.wf_graphql/apollo', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({
                query: 'mutation AddToCart($skuId: String!, $count: Int!, $buyNow: Boolean) { ecommerceAddToCart(sku: $skuId, count: $count, buyNow: $buyNow) { ok } }',
                variables: { skuId: SKU_ID, count: 1, buyNow: false }
              })
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              log('GraphQL response: ' + JSON.stringify(data));
              if (data && data[0] && data[0].data && data[0].data.ecommerceAddToCart && data[0].data.ecommerceAddToCart.ok) {
                title.textContent = 'Place réservée ! Redirection...';
                setTimeout(function() { window.location.href = '/checkout'; }, 1000);
              } else if (data && data.data && data.data.ecommerceAddToCart && data.data.ecommerceAddToCart.ok) {
                title.textContent = 'Place réservée ! Redirection...';
                setTimeout(function() { window.location.href = '/checkout'; }, 1000);
              } else {
                log('GraphQL failed, trying form click...');
                addViaFormClick();
              }
            })
            .catch(function(err) {
              log('GraphQL error: ' + err.message + ', trying form click...');
              addViaFormClick();
            });
          }

          // Method 2: Click the actual add-to-cart form (fallback)
          function addViaFormClick() {
            var form = document.querySelector('form[data-commerce-sku-id="' + SKU_ID + '"]');
            if (!form) {
              log('Form not found, retrying in 1s...');
              setTimeout(addViaFormClick, 1000);
              return;
            }
            log('Form found, submitting...');

            // Intercept navigation — Webflow will try to go to /checkout after add
            var origAssign = window.location.assign;
            var intercepted = false;

            // Watch for XHR/fetch to graphql to know when add-to-cart completes
            var origFetch = window.fetch;
            window.fetch = function() {
              var url = arguments[0];
              if (typeof url === 'string' && url.indexOf('graphql') !== -1) {
                log('Intercepted GraphQL fetch');
                return origFetch.apply(this, arguments).then(function(res) {
                  return res.clone().json().then(function(data) {
                    log('Cart response: ' + JSON.stringify(data).slice(0, 100));
                    if (!intercepted) {
                      intercepted = true;
                      title.textContent = 'Place réservée ! Redirection...';
                      setTimeout(function() { window.location.href = '/checkout'; }, 1500);
                    }
                    return res;
                  });
                });
              }
              return origFetch.apply(this, arguments);
            };

            // Click the hidden submit button
            var btn = form.querySelector('input[type="submit"]');
            if (btn) {
              btn.style.setProperty('display', 'block', 'important');
              btn.style.setProperty('visibility', 'visible', 'important');
              btn.style.setProperty('opacity', '0', 'important');
              btn.style.setProperty('position', 'fixed', 'important');
              btn.style.setProperty('top', '-9999px', 'important');
              btn.click();
              log('Submit button clicked');
            }

            // Also try dispatching submit event
            setTimeout(function() {
              if (!intercepted) {
                log('Dispatching submit event...');
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
            }, 500);

            // Safety fallback — redirect after 10s regardless
            setTimeout(function() {
              if (!intercepted) {
                log('Timeout — redirecting anyway');
                window.location.href = '/checkout';
              }
            }, 10000);
          }

          // Start: wait for page to be fully loaded
          if (document.readyState === 'complete') {
            setTimeout(addViaGraphQL, 2000);
          } else {
            window.addEventListener('load', function() {
              setTimeout(addViaGraphQL, 2000);
            });
          }
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
