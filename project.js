// Reusable public case-study renderer (project.html?slug=...). Fully public — reads the Career
// CMS anonymously (career_projects public read rule) and merges each field over a curated,
// user-verified fallback: the Owner's CMS content wins field-by-field, and the fallback fills any
// gap so a case study is never blank. Same source-of-truth policy as portfolio.js.
import { db } from "./firebase-init.js";
import { init as i18nInit, getLang, setLang, t } from "./js/i18n.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

function L() {
  return getLang() === "zh-CN" ? "zh" : "en";
}
function pick(obj) {
  if (!obj) return "";
  return obj[L()] || obj.en || "";
}
// DOM builder — Firestore-derived values are only ever set via textContent, never innerHTML.
function h(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  (opts.children || []).forEach((c) => c && el.appendChild(c));
  return el;
}

const CATEGORY_LABEL = {
  personal: { en: "Personal", zh: "个人" },
  internship: { en: "Internship", zh: "实习" },
  fyp: { en: "Final Year Project", zh: "毕业项目" },
  coursework: { en: "Coursework", zh: "课程项目" },
  work: { en: "Work", zh: "工作" },
};

// Fixed order for prev/next navigation across the featured case studies.
const ORDER = ["edenatlas", "utar-epms", "enterprise-ai-ops"];

// ==================== Curated, verified fallback case studies ====================
const CASE_STUDIES = {
  edenatlas: {
    name: { en: "EdenAtlas", zh: "EdenAtlas" },
    tag: { en: "Personal life platform", zh: "个人生活平台" },
    tech: ["HTML/CSS/JS", "Firebase Auth", "Firestore", "Firebase Storage", "PWA"],
    overview: {
      en: "EdenAtlas is a private, login-first personal platform that brings memories, journaling, career and daily life into one calm, unified home.",
      zh: "EdenAtlas 是一个私密、登录优先的个人平台，把回忆、日记、职业与日常整理进一个安静、统一的入口。",
    },
    problem: {
      en: "My personal data lived across many disconnected apps, with no single private place that I fully controlled.",
      zh: "我的个人数据分散在多个互不相连的 App 中，没有一个我能完全掌控的私密空间。",
    },
    role: {
      en: "Sole designer and developer — product design, data model, security rules and every page.",
      zh: "独立设计与开发——产品设计、数据模型、安全规则以及每一个页面。",
    },
    investigation: {
      en: "I chose a buildless static HTML/CSS/JS + Firebase stack to stay maintainable with no framework or build step, and designed a role model (Owner / Friend / Public) with per-user data scoping so private content can never leak between accounts.",
      zh: "我选择了无需构建的静态 HTML/CSS/JS + Firebase 技术栈，以在没有框架和构建步骤的情况下保持可维护；并设计了角色模型（Owner / Friend / Public）与按用户隔离的数据结构，使私密内容不会在账户间泄露。",
    },
    solution: {
      en: "Firebase Auth gates the whole app; Firestore and Storage hold per-uid content with security rules enforcing visibility (private / connections / public). A public résumé surface, English/Chinese i18n and an installable PWA round it out.",
      zh: "Firebase Auth 守护整个应用；Firestore 与 Storage 以按用户隔离的方式存储内容，并由安全规则强制可见性（私密 / 好友 / 公开）。再加上公开简历入口、中英双语与可安装的 PWA。",
    },
    result: {
      en: "A working multi-tenant personal platform I use daily, with a shareable public résumé and installable app — designed so privacy is enforced by security rules, not just the UI.",
      zh: "一个我每天使用的、可多用户使用的个人平台，带可分享的公开简历与可安装应用——隐私由安全规则强制保障，而不仅仅依赖界面。",
    },
    learned: {
      en: "Designing the security rules before the UI made the whole product simpler: access control is a data-model decision, not a screen.",
      zh: "先设计安全规则、再做界面，让整个产品更简单：访问控制是数据模型层面的决策，而不是某个页面的事。",
    },
  },
  "utar-epms": {
    name: { en: "UTAR Event Planning Management System", zh: "UTAR 活动策划管理系统" },
    tag: { en: "University coursework system", zh: "大学课程项目系统" },
    tech: ["System Analysis", "Database Design", "Web"],
    overview: {
      en: "A university Event Planning Management System built as coursework to digitize how campus events are proposed, approved and organized.",
      zh: "一个作为课程项目开发的大学活动策划管理系统，用于将校园活动的提案、审批与组织数字化。",
    },
    problem: {
      en: "Event planning ran on manual, fragmented steps — proposals, approvals and coordination were hard to track.",
      zh: "活动策划依赖手工、割裂的步骤——提案、审批与协调都难以跟踪。",
    },
    role: {
      en: "Contributed to requirements analysis, system and database design, and implementation of core modules.",
      zh: "参与需求分析、系统与数据库设计，以及核心模块的实现。",
    },
    investigation: {
      en: "I mapped the user roles and approval flow first, then modeled the data and screens around that workflow.",
      zh: "我先梳理用户角色与审批流程，再围绕这一流程设计数据结构与界面。",
    },
    solution: {
      en: "A structured system covering event proposals, role-based approval and the core planning workflow.",
      zh: "一个覆盖活动提案、基于角色的审批与核心策划流程的结构化系统。",
    },
    result: {
      en: "A working coursework deliverable demonstrating the end-to-end event management flow.",
      zh: "一个可运行的课程交付成果，展示了端到端的活动管理流程。",
    },
    learned: {
      en: "Getting the roles and approval flow right on paper first made the build far smoother.",
      zh: "先在纸面上把角色与审批流程理清楚，让后续开发顺畅了很多。",
    },
  },
  "enterprise-ai-ops": {
    name: { en: "Enterprise AI Platform & Operations Improvements", zh: "企业 AI 平台与运维改进" },
    tag: { en: "Internship (anonymized)", zh: "实习（已匿名）" },
    tech: ["TypeScript", "Django REST Framework", "Vue 3", "PostgreSQL", "MinIO", "Redis", "Celery", "Git"],
    overview: {
      en: "During an internship I worked across several internal AI platforms — an identity-verification review tool and an AutoML / chat-bot administration system — improving review workflows, analytics reliability and data operations.",
      zh: "在一次实习中，我参与了多个内部 AI 平台——一个身份核验审核工具，以及一个 AutoML / 聊天机器人管理系统——改进审核流程、分析可靠性与数据运维。",
    },
    problem: {
      en: "Internal review and analytics workflows were difficult to manage, some categories were hard-coded, historical data was inconsistent, and repeated CSV processing did not scale efficiently.",
      zh: "内部审核与分析流程难以管理，部分分类被硬编码，历史数据不一致，重复的 CSV 处理也难以高效扩展。",
    },
    role: {
      en: "Investigated existing frontend, backend, database and workflow logic; implemented scoped improvements; tested consistency; and presented progress for review.",
      zh: "梳理既有的前端、后端、数据库与流程逻辑；实现范围可控的改进；验证一致性；并汇报进展供评审。",
    },
    investigation: {
      en: "Selected work: a dedicated review-discussion workflow so cases needing discussion could be handled in one place; replacing hard-coded classifications with admin-configurable rules; improving frontend loading and filter usability; and introducing incremental data synchronization with a controlled full-refresh option.",
      zh: "主要工作：搭建专门的审核讨论流程，让需要讨论的案例集中处理；用管理员可配置的规则替换硬编码分类；改善前端加载与筛选可用性；并引入增量数据同步与可控的全量刷新选项。",
    },
    solution: {
      en: "Configurable category rules, a consolidated review-discussion queue, accordion-based advanced filters, and incremental CSV synchronization with a Force Data Loading escape hatch — validated for consistency across APIs, backend calculations and the dashboard.",
      zh: "可配置的分类规则、集中的审核讨论队列、折叠式高级筛选，以及带「强制加载」兜底的增量 CSV 同步——并在 API、后端计算与看板之间验证一致性。",
    },
    result: {
      en: "A more maintainable review and reporting workflow, reduced unnecessary repeat processing, and improved clarity and reliability — without exposing internal business data.",
      zh: "一个更易维护的审核与报表流程，减少了不必要的重复处理，并提升了清晰度与可靠性——且不暴露任何内部业务数据。",
    },
    learned: {
      en: "Verifying consistency across API responses, backend calculations and the dashboard taught me to treat data integrity as a first-class feature, and to keep unfinished work on separate branches from stable releases.",
      zh: "在 API 响应、后端计算与看板之间反复校验一致性，让我学会把数据完整性当作头等功能来对待，并把未完成的工作与稳定发布分支隔离开。",
    },
  },
};

// ==================== Load ====================
const params = new URLSearchParams(location.search);
const slug = (params.get("slug") || "").trim().toLowerCase();

function biField(doc, base) {
  return { en: doc[base + "_en"] || "", zh: doc[base + "_zh"] || doc[base + "_en"] || "" };
}

// Field-by-field merge: CMS value wins when it has content for the current language, else the
// curated fallback fills in. Returns null only when neither source knows this slug.
function buildCaseStudy(cmsDoc) {
  const base = CASE_STUDIES[slug] || null;
  if (!cmsDoc && !base) return null;

  const cms = cmsDoc
    ? {
        name: biField(cmsDoc, "title"),
        tag: CATEGORY_LABEL[cmsDoc.category] || { en: cmsDoc.category || "", zh: cmsDoc.category || "" },
        tech: cmsDoc.techStack || [],
        overview: biField(cmsDoc, "summary"),
        problem: biField(cmsDoc, "challenge"),
        role: biField(cmsDoc, "role"),
        investigation: biField(cmsDoc, "actions"),
        solution: biField(cmsDoc, "description"),
        result: biField(cmsDoc, "outcome"),
        learned: biField(cmsDoc, "reflection"),
      }
    : {};

  const has = (o) => o && (o.en || o.zh);
  const mergeText = (key) => (has(cms[key]) ? cms[key] : (base ? base[key] : null));
  const tech = (cms.tech && cms.tech.length) ? cms.tech : (base ? base.tech : []);

  return {
    name: has(cms.name) ? cms.name : (base ? base.name : { en: "", zh: "" }),
    tag: has(cms.tag) ? cms.tag : (base ? base.tag : { en: "", zh: "" }),
    tech,
    overview: mergeText("overview"),
    problem: mergeText("problem"),
    role: mergeText("role"),
    investigation: mergeText("investigation"),
    solution: mergeText("solution"),
    result: mergeText("result"),
    learned: mergeText("learned"),
  };
}

let study = null;

function section(labelKey, value) {
  if (!value || !pick(value)) return null;
  const body = h("p", { class: "text-base text-white/90 mt-3 leading-relaxed max-w-3xl", text: pick(value) });
  body.style.whiteSpace = "pre-wrap";
  return h("section", { class: "reveal", children: [
    h("h2", { class: "text-[11px] uppercase tracking-[0.2em] text-neonPurple font-code", text: t(labelKey) }),
    body,
  ] });
}

function navCard(targetSlug, dir) {
  // Neighbour names come from the static CASE_STUDIES fallback (not CMS), but build via DOM
  // + property assignment for uniform safety and so the href can never be attribute-injected.
  const s = CASE_STUDIES[targetSlug];
  const label = dir === "prev" ? t("project.prev") : t("project.next");
  const align = dir === "prev" ? "" : "sm:text-right sm:items-end";
  const a = h("a", { class: `card-lift flex flex-col ${align} gap-1 bg-cardBg/70 border border-borderNeon rounded-xl p-4 hover:border-neonPurple transition-all`, children: [
    h("span", { class: "text-[10px] uppercase tracking-[0.15em] text-textGray font-code", text: label }),
    h("span", { class: "text-sm font-cyber font-bold text-white", text: pick(s.name) }),
  ] });
  a.href = "project.html?slug=" + encodeURIComponent(targetSlug);
  return a;
}

function renderNav() {
  const idx = ORDER.indexOf(slug);
  const cards = [];
  cards.push(idx > 0 ? navCard(ORDER[idx - 1], "prev") : h("span"));
  if (idx >= 0 && idx < ORDER.length - 1) cards.push(navCard(ORDER[idx + 1], "next"));
  document.getElementById("cs-nav").replaceChildren(...cards);
}

function render() {
  if (!study) return;
  document.getElementById("cs-eyebrow").textContent = pick(study.tag);
  const title = pick(study.name);
  document.getElementById("cs-title").textContent = title;
  document.title = `${title} — Low Fang Jun`;
  const techRow = document.getElementById("cs-tech-top");
  techRow.replaceChildren(
    ...(study.tech || []).map((s) => h("span", { class: "px-2.5 py-1 rounded-full border border-borderNeon text-[11px] font-code text-textGray", text: s }))
  );
  document.getElementById("cs-body").replaceChildren(
    ...[
      section("project.overview", study.overview),
      section("project.problem", study.problem),
      section("project.my_role", study.role),
      section("project.investigation", study.investigation),
      section("project.solution", study.solution),
      section("project.result", study.result),
      section("project.what_i_learned", study.learned),
    ].filter(Boolean)
  );
  if (ORDER.includes(slug)) renderNav();
  // Newly injected .reveal sections: reveal them (scripts.js's observer already ran on load).
  document.querySelectorAll("#cs-article .reveal").forEach((el) => el.classList.add("is-visible"));
}

async function fetchCmsProject() {
  if (!slug) return null;
  try {
    const snap = await getDocs(query(collection(db, "career_projects"), where("visibility", "==", "public")));
    const match = snap.docs.map((d) => ({ id: d.id, ...d.data() })).find((p) => (p.slug || "").trim().toLowerCase() === slug);
    return match || null;
  } catch (err) {
    console.error("[project] CMS fetch failed:", err.code || err);
    return null;
  }
}

function showNotFound() {
  document.getElementById("cs-loading").classList.add("hidden");
  document.getElementById("cs-article").classList.add("hidden");
  document.getElementById("cs-notfound").classList.remove("hidden");
}

// ==================== Language toggle ====================
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
document.addEventListener("eden:langchange", () => {
  render();
  syncLangButtons();
});

// ==================== Boot ====================
(async () => {
  await i18nInit();
  syncLangButtons();
  const cmsDoc = await fetchCmsProject();
  study = buildCaseStudy(cmsDoc);
  document.getElementById("cs-loading").classList.add("hidden");
  if (!study) {
    showNotFound();
    return;
  }
  document.getElementById("cs-article").classList.remove("hidden");
  render();
})();
