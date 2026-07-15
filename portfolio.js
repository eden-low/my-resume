// Recruiter-facing public portfolio (portfolio.html). Fully public — no auth-guard, no
// private-app sidebar/mobile-nav. Reads the Career CMS (career_projects / career_experiences)
// anonymously via each doc's public read rule (firestore.rules' isCareerReadable → a
// `visibility == 'public'` career doc is readable with NO request.auth), and falls back to the
// curated, user-verified content below when the CMS has nothing to show yet.
//
// Source-of-truth policy: the Career CMS is authoritative. The FALLBACK_* data here is only
// rendered when the CMS returns no matching public items — the same "graceful fallback to the
// existing summary" pattern used across this codebase. Once the Owner populates the CMS (marking
// EdenAtlas / EPMS / the internship project as `featured` with a `slug`), CMS data wins.
import { db } from "./firebase-init.js";
import { init as i18nInit, getLang, setLang, t } from "./js/i18n.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// "en" | "zh" — collapse the app's zh-CN locale code to the key our bilingual data objects use.
function L() {
  return getLang() === "zh-CN" ? "zh" : "en";
}
// Pick from a { en, zh } object, falling back to English so a half-translated field never blanks.
function pick(obj) {
  if (!obj) return "";
  return obj[L()] || obj.en || "";
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// DOM builder — used for every Firestore-derived value so untrusted CMS strings are only ever
// set via textContent / element properties, never interpolated into innerHTML.
function h(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  (opts.children || []).forEach((c) => c && el.appendChild(c));
  return el;
}
function faIcon(cls) {
  const i = document.createElement("i");
  i.className = cls;
  return i;
}
function pillSpan(text) {
  return h("span", { class: "px-2 py-0.5 rounded-full border border-borderNeon text-[10px] font-code text-textGray", text });
}

const CATEGORY_LABEL = {
  personal: { en: "Personal", zh: "个人" },
  internship: { en: "Internship", zh: "实习" },
  fyp: { en: "Final Year Project", zh: "毕业项目" },
  coursework: { en: "Coursework", zh: "课程项目" },
  work: { en: "Work", zh: "工作" },
};

// ==================== Curated, verified fallback content ====================
// Everything here is drawn from the Owner's own résumé data and the sanctioned internship
// summary — no fabricated metrics. Bilingual so the language toggle re-renders live.

const HERO = {
  eyebrow: { en: "Hi, I'm Eden 👋", zh: "你好，我是 Eden 👋" },
  subhead: {
    en: "Business Information Systems student focused on web applications, data workflows, and technical operations.",
    zh: "商业信息系统在读，专注于 Web 应用、数据流程与技术运维。",
  },
  oneliner: {
    en: "I turn operational problems into practical, maintainable digital solutions.",
    zh: "我把运营中的实际问题，转化为可落地、易维护的数字方案。",
  },
  labels: [
    { en: "Business Information Systems", zh: "商业信息系统" },
    { en: "Tech & Operations", zh: "技术与运维" },
    { en: "Malaysia", zh: "马来西亚" },
    { en: "Open to opportunities", zh: "开放机会中" },
  ],
};

const SNAPSHOT = {
  focus: { en: "Web applications & technical operations", zh: "Web 应用与技术运维" },
  education: { en: "B. Information Systems (Hons), BIS — UTAR", zh: "信息系统（荣誉）学士 · 商业信息系统 — UTAR" },
  location: { en: "Kuching, Sarawak, Malaysia", zh: "马来西亚 · 砂拉越 · 古晋" },
  corefocus: { en: "Web dev, data workflows, system usability", zh: "Web 开发、数据流程、系统可用性" },
};

const FALLBACK_PROJECTS = [
  {
    slug: "edenatlas",
    name: { en: "EdenAtlas", zh: "EdenAtlas" },
    tag: { en: "Personal life platform", zh: "个人生活平台" },
    problem: {
      en: "Memories, journaling, career and daily life were scattered across half a dozen apps with no private, unified home.",
      zh: "回忆、日记、职业与日常散落在多个 App 中，没有一个私密、统一的入口。",
    },
    role: {
      en: "Sole designer and developer — built the entire product end to end.",
      zh: "独立设计与开发，端到端完成整个产品。",
    },
    outcome: {
      en: "A login-first, role-based platform (Owner / Friend / Public) with a public résumé surface, English/Chinese i18n and an installable PWA.",
      zh: "一个登录优先、基于角色（Owner / Friend / Public）的平台，带公开简历入口、中英双语与可安装 PWA。",
    },
    tech: ["HTML/CSS/JS", "Firebase Auth", "Firestore", "Storage"],
    featured: true,
  },
  {
    slug: "utar-epms",
    name: { en: "UTAR Event Planning Management System", zh: "UTAR 活动策划管理系统" },
    tag: { en: "University coursework system", zh: "大学课程项目系统" },
    problem: {
      en: "University event planning relied on manual, fragmented steps that were hard to coordinate and track.",
      zh: "大学活动策划依赖手工、割裂的步骤，难以协调与跟踪。",
    },
    role: {
      en: "Contributed to requirements analysis, system and database design, and implementation.",
      zh: "参与需求分析、系统与数据库设计及实现。",
    },
    outcome: {
      en: "A structured event planning and approval system covering the core user roles and workflow.",
      zh: "一个覆盖核心用户角色与流程的结构化活动策划与审批系统。",
    },
    tech: ["System Analysis", "Database Design", "Web"],
    featured: true,
  },
  {
    slug: "enterprise-ai-ops",
    name: { en: "Enterprise AI Platform & Operations Improvements", zh: "企业 AI 平台与运维改进" },
    tag: { en: "Internship (anonymized)", zh: "实习（已匿名）" },
    problem: {
      en: "Internal review and analytics workflows were hard to manage — some categories were hard-coded, historical data was inconsistent, and repeated CSV processing didn't scale.",
      zh: "内部审核与分析流程难以管理——部分分类硬编码、历史数据不一致，且重复的 CSV 处理难以扩展。",
    },
    role: {
      en: "Investigated existing frontend, backend, database and workflow logic; implemented scoped improvements and tested consistency.",
      zh: "梳理既有前端、后端、数据库与流程逻辑；实现范围可控的改进并验证一致性。",
    },
    outcome: {
      en: "A more maintainable review and reporting workflow with less unnecessary reprocessing — without exposing internal business data.",
      zh: "更易维护的审核与报表流程，减少不必要的重复处理——且不暴露任何内部业务数据。",
    },
    tech: ["TypeScript", "Django REST", "Vue 3", "PostgreSQL", "Redis", "Celery"],
    featured: true,
  },
];

const FALLBACK_EXPERIENCE = [
  {
    role: { en: "Technical & Operations Intern", zh: "技术与运维实习生" },
    company: { en: "AI technology company", zh: "AI 科技公司" },
    dates: "Jun 2026 – Present",
    location: { en: "Malaysia", zh: "马来西亚" },
    bullets: [
      {
        en: "Delivered workflow and interface improvements for internal AI verification and administration systems, including a dedicated review-discussion workflow and clearer worker identification.",
        zh: "为内部 AI 核验与管理系统交付流程与界面改进，包括专门的审核讨论流程与更清晰的操作员标识。",
      },
      {
        en: "Improved analytics reliability by replacing hard-coded category logic with configurable rules and validating consistency between APIs, dashboard totals and detailed classifications.",
        zh: "以可配置规则替换硬编码分类逻辑，并校验 API、看板汇总与明细分类之间的一致性，提升分析可靠性。",
      },
      {
        en: "Optimized data operations through incremental CSV synchronization, database indexing and a controlled full-refresh fallback, followed by data-integrity checks.",
        zh: "通过增量 CSV 同步、数据库索引与可控的全量刷新兜底优化数据处理，并进行数据完整性校验。",
      },
      {
        en: "Contributed across frontend, backend and operational workflows using TypeScript, Django-based services, Git and database validation while supporting AI annotation and dataset quality control.",
        zh: "使用 TypeScript、基于 Django 的服务、Git 与数据库校验，横跨前端、后端与运维流程贡献，同时支持 AI 标注与数据集质量控制。",
      },
    ],
    caseSlug: "enterprise-ai-ops",
  },
];

const LEADERSHIP = [
  {
    role: { en: "Chairperson", zh: "主席" },
    event: { en: "UTAR Orientation Telematch (IBT 2026)", zh: "UTAR 迎新 Telematch（IBT 2026）" },
    date: "Mar 2026",
    bullets: [
      {
        en: "Coordinated an orientation event for ~300 freshmen and ~500 total participants including committee and helpers.",
        zh: "统筹面向约 300 名新生、连同委员与工作人员共约 500 人的迎新活动。",
      },
      {
        en: "Led a 41–42-member committee through preparation, rehearsals and event-day execution.",
        zh: "带领 41–42 人的委员会完成筹备、彩排与活动当天的执行。",
      },
      {
        en: "Managed cross-department communication, scheduling and operational decisions.",
        zh: "负责跨部门沟通、排期与运营决策。",
      },
    ],
  },
  {
    role: { en: "Chairperson", zh: "主席" },
    event: { en: "Buddhist Society Welcoming Night", zh: "佛学会迎新之夜" },
    date: "Oct 2024",
    bullets: [],
  },
  {
    role: { en: "Program Leader", zh: "节目负责人" },
    event: { en: "ISC 2025", zh: "ISC 2025" },
    date: "2025",
    bullets: [],
  },
];

const SKILLS = [
  { title: { en: "Web Development", zh: "Web 开发" }, items: ["HTML", "CSS", "JavaScript", "Firebase (Auth / Firestore / Storage)", "Responsive UI"] },
  { title: { en: "Data & Analysis", zh: "数据与分析" }, items: ["SQL", "PostgreSQL", "Data validation", "CSV / data workflows"] },
  { title: { en: "Systems & Operations", zh: "系统与运维" }, items: ["Git / version control", "System analysis", "Workflow design", "Debugging"] },
  { title: { en: "Product & Business", zh: "产品与业务" }, items: ["Business Information Systems", "Requirements analysis", "Documentation"] },
  { title: { en: "Collaboration", zh: "协作" }, items: ["Leadership", "Cross-team coordination", "Communication"] },
];
const FAMILIAR = ["TypeScript", "Vue 3", "Django REST Framework", "Redis", "Celery", "MinIO"];

const ABOUT = [
  {
    en: "I'm a Business Information Systems student who likes sitting between the business problem and the technical solution — understanding how people actually work, then building software that makes that work simpler and more reliable.",
    zh: "我是一名商业信息系统学生，喜欢站在业务问题与技术方案之间——先理解人们真实的工作方式，再构建让这些工作更简单、更可靠的软件。",
  },
  {
    en: "Most of what I build is web-based and data-driven: internal tools, review and reporting workflows, and personal platforms. I care about maintainability, clear data, and interfaces that stay out of the way.",
    zh: "我做的大多是基于 Web、由数据驱动的东西：内部工具、审核与报表流程，以及个人平台。我在意可维护性、清晰的数据，以及不碍事的界面。",
  },
];

// ==================== State (CMS data supersedes fallbacks once loaded) ====================
// The three canonical featured slugs, in display order — matched against public CMS projects,
// filled from FALLBACK_PROJECTS when a slug has no public CMS match.
const EXPECTED_SLUGS = ["edenatlas", "utar-epms", "enterprise-ai-ops"];
let cmsPublicProjects = []; // normalized public career_projects, populated by loadCms()
let experiences = FALLBACK_EXPERIENCE;

// ---- Normalize a CMS doc into the same { en, zh } shape the fallbacks use ----
function biField(doc, base) {
  return { en: doc[base + "_en"] || "", zh: doc[base + "_zh"] || doc[base + "_en"] || "" };
}
function normalizeProject(doc) {
  return {
    id: doc.id,
    _createdMs: doc.createdAt?.toMillis?.() || 0,
    slug: (doc.slug || "").trim().toLowerCase(),
    name: biField(doc, "title"),
    tag: CATEGORY_LABEL[doc.category] || { en: doc.category || "", zh: doc.category || "" },
    problem: biField(doc, "challenge"),
    role: biField(doc, "role"),
    // Result falls back to the project summary when no explicit outcome was written.
    outcome: {
      en: doc.outcome_en || doc.summary_en || "",
      zh: doc.outcome_zh || doc.summary_zh || doc.outcome_en || doc.summary_en || "",
    },
    tech: doc.techStack || [],
    featured: !!doc.featured,
  };
}
function normalizeExperience(doc) {
  return {
    role: biField(doc, "role"),
    company: { en: doc.company || "", zh: doc.company || "" },
    dates: `${doc.startDate || ""}${doc.startDate || doc.endDate ? " – " : ""}${doc.endDate || (doc.startDate ? "Present" : "")}`,
    location: { en: doc.location || "", zh: doc.location || "" },
    body: biField(doc, "description"),
    bullets: [],
    skills: doc.skills || [],
    _start: doc.startDate || "",
  };
}

// ==================== Rendering ====================

function renderHero() {
  document.getElementById("hero-eyebrow").textContent = pick(HERO.eyebrow);
  document.getElementById("hero-subhead").textContent = pick(HERO.subhead);
  document.getElementById("hero-oneliner").textContent = pick(HERO.oneliner);
  document.getElementById("hero-labels").innerHTML = HERO.labels
    .map((l) => `<span class="px-3 py-1.5 rounded-full bg-cardBg/70 border border-borderNeon text-xs font-code text-textGray">${esc(pick(l))}</span>`)
    .join("");
}

function renderSnapshot() {
  document.getElementById("snap-focus").textContent = pick(SNAPSHOT.focus);
  document.getElementById("snap-education").textContent = pick(SNAPSHOT.education);
  document.getElementById("snap-location").textContent = pick(SNAPSHOT.location);
  document.getElementById("snap-corefocus").textContent = pick(SNAPSHOT.corefocus);
}

function metaRowEl(label, value) {
  if (!value) return null;
  return h("div", { class: "mt-3", children: [
    h("p", { class: "text-[10px] uppercase tracking-[0.15em] text-textGray font-code", text: label }),
    h("p", { class: "text-sm text-white/90 mt-1 leading-relaxed", text: value }),
  ] });
}

function caseStudyLink(slug, extraClass) {
  const a = h("a", { class: `${extraClass} inline-flex items-center gap-1.5 text-xs font-code text-neonPurple hover:underline`, text: t("portfolio.view_case_study") + " " });
  a.href = "project.html?slug=" + encodeURIComponent(slug); // property assignment — never innerHTML
  a.appendChild(faIcon("fa-solid fa-arrow-right text-[10px]"));
  return a;
}

function projectCard(p) {
  const art = h("article", { class: "card-lift bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple flex flex-col" });
  art.appendChild(h("p", { class: "text-[10px] uppercase tracking-[0.2em] text-neonPurple font-code", text: pick(p.tag) }));
  art.appendChild(h("h3", { class: "font-cyber font-bold text-lg text-white mt-1.5", text: pick(p.name) }));
  [
    metaRowEl(t("portfolio.lbl_problem"), pick(p.problem)),
    metaRowEl(t("portfolio.lbl_role"), pick(p.role)),
    metaRowEl(t("portfolio.lbl_outcome"), pick(p.outcome)),
  ].forEach((n) => n && art.appendChild(n));
  if ((p.tech || []).length) {
    const row = h("div", { class: "flex flex-wrap gap-1.5 mt-4" });
    p.tech.slice(0, 5).forEach((s) => row.appendChild(pillSpan(s)));
    art.appendChild(row);
  }
  const footer = h("div", { class: "mt-auto" });
  if (p.slug) footer.appendChild(caseStudyLink(p.slug, "mt-5"));
  art.appendChild(footer);
  return art;
}

// Deterministic per-slug Selected Work list: for each expected slug prefer a public CMS project
// matched by slug, else the curated fallback; then append any extra public *featured* CMS projects
// (newest first), deduped by slug/id so no card and no case study appears twice.
function buildWorkList() {
  const fallbackBySlug = new Map(FALLBACK_PROJECTS.map((p) => [p.slug, p]));
  const cmsBySlug = new Map();
  cmsPublicProjects.forEach((p) => { if (p.slug && !cmsBySlug.has(p.slug)) cmsBySlug.set(p.slug, p); });

  const used = new Set();
  const list = [];
  EXPECTED_SLUGS.forEach((slug) => {
    const chosen = cmsBySlug.get(slug) || fallbackBySlug.get(slug);
    if (chosen) { list.push(chosen); used.add(slug); }
  });

  cmsPublicProjects
    .filter((p) => p.featured)
    .slice()
    .sort((a, b) => (b._createdMs || 0) - (a._createdMs || 0))
    .forEach((p) => {
      const key = p.slug || p.id;
      if (!key || used.has(key)) return; // skip an expected-slot match or an already-added extra
      used.add(key);
      list.push(p);
    });

  return list;
}

function renderWork() {
  document.getElementById("work-list").replaceChildren(...buildWorkList().map(projectCard));
}

function experienceCard(exp) {
  const art = h("article", { class: "bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple" });
  art.appendChild(h("h3", { class: "font-cyber font-bold text-base text-white", text: pick(exp.role) }));
  const metaBits = [pick(exp.company), exp.dates, pick(exp.location)].filter(Boolean).join(" · ");
  if (metaBits) art.appendChild(h("p", { class: "text-xs text-neonPurple font-code mt-1", text: metaBits }));
  if (exp.bullets && exp.bullets.length) {
    const ul = h("ul", { class: "mt-3 space-y-2 text-sm text-textGray leading-relaxed list-disc list-inside" });
    exp.bullets.forEach((b) => ul.appendChild(h("li", { text: pick(b) })));
    art.appendChild(ul);
  } else if (pick(exp.body)) {
    art.appendChild(h("p", { class: "mt-3 text-sm text-textGray leading-relaxed", text: pick(exp.body) }));
  }
  if ((exp.skills || []).length) {
    const row = h("div", { class: "flex flex-wrap gap-1.5 mt-3" });
    exp.skills.forEach((s) => row.appendChild(pillSpan(s)));
    art.appendChild(row);
  }
  if (exp.caseSlug) art.appendChild(caseStudyLink(exp.caseSlug, "mt-4"));
  return art;
}

function renderExperience() {
  document.getElementById("experience-list").replaceChildren(...experiences.map(experienceCard));
}

function renderLeadership() {
  document.getElementById("leadership-list").innerHTML = LEADERSHIP.map((l) => {
    const bullets = l.bullets && l.bullets.length
      ? `<ul class="mt-3 space-y-1.5 text-sm text-textGray leading-relaxed list-disc list-inside">
           ${l.bullets.map((b) => `<li>${esc(pick(b))}</li>`).join("")}
         </ul>`
      : "";
    return `
      <article class="bg-cardBg/90 backdrop-blur-sm p-6 rounded-2xl neon-border-purple">
        <div class="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
          <p class="font-cyber font-bold text-sm text-white">${esc(pick(l.role))} — ${esc(pick(l.event))}</p>
          <span class="text-[11px] font-code text-textGray flex-shrink-0">${esc(l.date)}</span>
        </div>
        ${bullets}
      </article>`;
  }).join("");
}

function renderSkills() {
  document.getElementById("skills-list").innerHTML = SKILLS.map((g) => `
    <div class="bg-cardBg/90 backdrop-blur-sm p-5 rounded-2xl neon-border-purple">
      <p class="font-cyber font-bold text-xs text-white tracking-wider">${esc(pick(g.title))}</p>
      <div class="flex flex-wrap gap-2 mt-3">
        ${g.items.map((s) => `<span class="px-3 py-1.5 rounded-full bg-darkBg/60 border border-borderNeon text-xs font-code text-textGray">${esc(s)}</span>`).join("")}
      </div>
    </div>`).join("");
  document.getElementById("skills-familiar").innerHTML =
    `${esc(t("portfolio.skills_familiar_note"))} ${FAMILIAR.map(esc).join(" · ")}`;
}

function renderAbout() {
  document.getElementById("about-body").innerHTML = ABOUT.map((p) => `<p>${esc(pick(p))}</p>`).join("");
}

function renderAll() {
  renderHero();
  renderSnapshot();
  renderWork();
  renderExperience();
  renderLeadership();
  renderSkills();
  renderAbout();
}

// ==================== CMS load (supersedes fallbacks when present) ====================
async function fetchPublic(name) {
  try {
    const snap = await getDocs(query(collection(db, name), where("visibility", "==", "public")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error(`[portfolio] ${name} public fetch failed:`, err.code || err);
    return [];
  }
}

async function loadCms() {
  const [projDocs, expDocs] = await Promise.all([
    fetchPublic("career_projects"),
    fetchPublic("career_experiences"),
  ]);

  // Only PUBLIC docs are ever fetched (query filters visibility=='public'), so a private CMS
  // project can never enter this list and therefore can never override or suppress a fallback.
  cmsPublicProjects = projDocs.map(normalizeProject);
  renderWork(); // buildWorkList() does the deterministic per-slug merge

  if (expDocs.length) {
    experiences = expDocs.map(normalizeExperience).sort((a, b) => (b._start || "").localeCompare(a._start || ""));
    renderExperience();
  }
}

// ==================== Language toggle + mobile nav ====================
function syncLangButtons() {
  const zh = L() === "zh";
  const en = document.getElementById("lang-en");
  const zhBtn = document.getElementById("lang-zh");
  en.classList.toggle("text-white", !zh);
  en.classList.toggle("text-textGray", zh);
  zhBtn.classList.toggle("text-white", zh);
  zhBtn.classList.toggle("text-textGray", !zh);
}

document.getElementById("lang-en").addEventListener("click", () => setLang("en"));
document.getElementById("lang-zh").addEventListener("click", () => setLang("zh-CN"));

const navToggle = document.getElementById("nav-toggle");
const mobileMenu = document.getElementById("mobile-menu");
navToggle.addEventListener("click", () => {
  const open = mobileMenu.classList.toggle("hidden") === false;
  navToggle.setAttribute("aria-expanded", String(open));
});
document.querySelectorAll(".mobile-menu-link").forEach((a) =>
  a.addEventListener("click", () => {
    mobileMenu.classList.add("hidden");
    navToggle.setAttribute("aria-expanded", "false");
  })
);

// Re-render all bilingual content on a language switch (chrome/data-i18n is handled by i18n.js).
document.addEventListener("eden:langchange", () => {
  renderAll();
  syncLangButtons();
});

// ==================== Boot ====================
(async () => {
  await i18nInit(); // ensures getLang() reflects the resolved language before first render
  renderAll();
  syncLangButtons();
  loadCms();
})();
