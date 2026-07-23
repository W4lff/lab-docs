mermaid.initialize({ startOnLoad: false, theme: "dark" });

const docList = document.getElementById("doc-list");
const content = document.getElementById("content");
const searchInput = document.getElementById("search");
const searchResults = document.getElementById("search-results");
const vaultBanner = document.getElementById("vault-banner");

async function loadVaultGreeting() {
  try {
    const res = await fetch("/api/vault-greeting");
    const data = await res.json();
    vaultBanner.textContent = data.greeting
      ? `🔐 ${data.greeting}`
      : "🔐 segredo carregado do Vault";
  } catch {
    vaultBanner.textContent = "🔐 aguardando segredo do Vault…";
  }
}

async function loadDocList() {
  const res = await fetch("/api/docs");
  const docs = await res.json();
  docList.innerHTML = docs
    .map((d) => `<li><a href="#${d.slug}" data-slug="${d.slug}">${d.title}</a></li>`)
    .join("");
  return docs;
}

function renderMermaidBlocks(container) {
  container.querySelectorAll("pre code.language-mermaid").forEach((codeEl) => {
    const pre = codeEl.parentElement;
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = codeEl.textContent;
    pre.replaceWith(div);
  });
  mermaid.run({ querySelector: ".mermaid" });
}

async function loadDoc(slug) {
  const res = await fetch(`/api/docs/${slug}`);
  if (!res.ok) {
    content.innerHTML = "<p>Página não encontrada.</p>";
    return;
  }
  const doc = await res.json();
  content.innerHTML = doc.html;
  renderMermaidBlocks(content);
  document.querySelectorAll("#doc-list a").forEach((a) => {
    a.classList.toggle("active", a.dataset.slug === slug);
  });
  window.location.hash = slug;
}

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) {
    searchResults.innerHTML = "";
    return;
  }
  searchTimer = setTimeout(async () => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    searchResults.innerHTML = results
      .map(
        (r) =>
          `<div class="result"><a href="#${r.slug}" data-slug="${r.slug}">${r.title}</a><div class="snippet">${r.snippet}</div></div>`
      )
      .join("") || "<div class=\"result\">Nada encontrado.</div>";
    searchResults.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        loadDoc(a.dataset.slug);
      });
    });
  }, 250);
});

docList.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-slug]");
  if (!a) return;
  e.preventDefault();
  loadDoc(a.dataset.slug);
});

(async function init() {
  loadVaultGreeting();
  const docs = await loadDocList();
  const initial = window.location.hash.replace("#", "") || (docs[0] && docs[0].slug);
  if (initial) loadDoc(initial);
})();
