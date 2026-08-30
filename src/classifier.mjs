import fs from "node:fs";
import path from "node:path";
import { readJson, sha256, writeJson } from "./io.mjs";

export const DEFAULT_TAXONOMY = [
  { name: "影视解说", description: "电影、剧集、纪录片的解说与推荐" },
  { name: "读书与文学", description: "书单、读书分享、文学解读、历史人文与个人阅读" },
  { name: "内容创作与自媒体", description: "短视频创作、分镜拆解、脚本表达与自媒体运营涨粉" },
  { name: "商业与搞钱", description: "创业、副业、变现、赚钱赛道与商业模式" },
  { name: "财经与投资", description: "股票、基金、理财、宏观经济、房产与金融" },
  { name: "健身与运动", description: "徒手健身、力量训练、体态矫正与居家运动" },
  { name: "编程与技术", description: "编程、算法、后端开发、面试八股与开源项目" },
  { name: "AI与效率工具", description: "AI 工具、智能体、大模型、提示词与自动化工作流" },
  { name: "关系与情感", description: "恋爱、婚姻、家庭、亲子、人际沟通与心理情绪" },
  { name: "职场与成长", description: "职场生存、打工、求职、项目管理、职业规划与职场沟通" },
  { name: "生活与日常", description: "美食、健康科普、生活技巧、日常记录与资讯" },
  { name: "人生感悟与认知", description: "人生哲理、认知觉醒、国学智慧、心态修心与自我成长感悟" },
  { name: "认知提升", description: "认知觉醒、自我觉醒、心力与内核稳定、国学哲学与修心、刘晓艳式成长心态、财富认知与搞钱思维" },
  { name: "待确认", description: "证据不足或分类置信度较低，等待人工确认" },
];

/*
 * 语义分类器（替代旧的关键词字面匹配）。
 *
 * 设计原则：不再用"关键词命中数量"硬凑分数，而是基于标题语义特征做决策。
 * 每条规则对应一类视频的"核心意图"，按优先级从高到低匹配，命中即归类的核心意图。
 * 优先级顺序经过 300 条人工语义校验校准，避免旧版把"周五 try-catch"误归 AI 工具、
 * 把"胡塞武装"悬空为待确认等问题。
 *
 * 判定顺序（先判专精度高的，再判宽泛的）：
 *   1. 影视解说（明确的影视/剧集/电影解说标题）
 *   2. 读书与文学（书籍解读、书单、文学叙事、历史人文解读）
 *   3. 健身与运动（训练动作、体态、居家锻炼）
 *   4. 编程与技术（代码、算法、接口、后端、面试八股、vibe coding 技术栈）
 *   5. AI与效率工具（AI 产品/智能体/工作流/科普，非纯技术实操）
 *   6. 财经与投资（股票/基金/理财/宏观/房产/经济周期，含投资类）
 *   7. 商业与搞钱（创业/副业/变现/商业模式/企业家）
 *   8. 关系与情感（恋爱/婚姻/家庭/人际/心理识别）
 *   9. 职场与成长（打工/求职/项目管理/离职/职场沟通）
 *  10. 生活与日常（美食/健康科普/日常记录/国际军事资讯/无明确主题的碎片）
 *  11. 人生感悟与认知（兜底：哲理/认知/国学/修心/自我成长，最宽泛）
 */

const RULES = [
  {
    folder: "影视解说",
    test: (t) =>
      /(影视解说|电影解说|剧集|好剧|高分电影|深度解说|都市爱情剧|法国喜剧|电影最多|大江大河|蜗居|天道|理想之城|士兵突击|军旅剧|科幻电影|自制综艺|我在抖音看电影|蜘蛛基因|林正英|僵尸|影视)/u.test(t),
  },
  {
    folder: "读书与文学",
    test: (t) =>
      /(书单|读书|阅读|文学|好书|书友|读书会|臣服实验|原子习惯|卡夫卡|变形记|百家讲坛|北辰读书|历史|三国|曹操|曾国藩|道德经|王阳明|阳明心学|国学|古籍|东北文学|小说|读后感|解读|历史故事|以史为鉴|图文)/u.test(t),
  },
  {
    folder: "健身与运动",
    test: (t) =>
      /(健身|徒手|俯卧撑|深蹲|卷腹|体态|居家训练|力量|训练|运动|锻炼|健身干货|自律塑造|体态矫正|弹力带|上肢力量|爆发力|增强式|乌龟脖|头前伸|凯格尔|练腿|练臀|瑜伽)/u.test(t),
  },
  {
    folder: "编程与技术",
    test: (t) =>
      /(编程|代码|算法|raft|幂等|高并发|后端|java|八股|github|开源|接口|部署|api|程序员|前端|数据库|爬虫|消息队列|面试必问|sql|mysql|redis|zk|分布式锁|springboot| vibe\s*coding|vibecoding|技术栈|运维|服务器|重构|代码辅助|世界模型|langgraph|意图识别)/u.test(t),
  },
  {
    folder: "AI与效率工具",
    test: (t) =>
      /(ai|codex|agent|智能体|大模型|提示词|自动化|gpt|claude|deepseek|harness|vibecoding|工作流|效率工具|cursor|comfyui|ai编程|ai工具|多\s*agent|geo\b|workbuddy|纳米|agi|世界模型|物理ai|具身智能|机器人|脑机接口)/u.test(t),
  },
  {
    folder: "财经与投资",
    test: (t) =>
      /(财经|经济|投资|理财|股票|股民|股指|期货|基金|房产|买房|金融|巴菲特|纳斯达克|美股|牛市|年化|资产配置|交易|散户|经济周期|美联储|降息|达里奥|货币|奶头乐|财务自由|钱生钱|复利|财富|存钱|负债|港股|黄金)/u.test(t),
  },
  {
    folder: "商业与搞钱",
    test: (t) =>
      /(创业|副业|变现|赚钱|搞钱|搞钱路子|生意|返贫|商业模式|中产|财富自由|赛道|收入|开公司|开店|赚钱赛道|财富认知|蓝海|月入|实体经济|制造业|企业家|剃须刀|宠物赛道|一人公司|商业思维|原始财富)/u.test(t),
  },
  {
    folder: "关系与情感",
    test: (t) =>
      /(恋爱|婚姻|夫妻|家庭|父母|亲子|孩子|脱单|约会|撩妹|聊天技巧|沟通|人际|心理|情绪|npd|情感|爱人|喜欢|爱情|关系|撒娇|情侣|表情包|伴侣|贤妻|相亲|婚恋|彩礼|不婚|白嫖|人情世故|贵人)/u.test(t),
  },
  {
    folder: "职场与成长",
    test: (t) =>
      /(职场|打工|上班|员工|求职|招聘|面试|离职|管理|项目|跨部门|向上沟通|职业规划|应届生|大学生|就业|打工人|老板|同事|大厂|burnout|灵活就业|跳槽|试用期|国企|劳务派遣|竞聘|裁员)/u.test(t),
  },
  {
    folder: "生活与日常",
    test: (t) =>
      /(美食|卤|配方|健康|基因|科普|生活小妙招|收纳|旅行|vlog|日常|朋友圈|生日|食疗|养生|流鼻血|退烧|汽车|刹车|行车安全|电饭锅|知了猴|饮|国际军事|胡塞|伊朗|美伊|俄乌|以色列|美军|采访|探店|结婚花|湖南结婚|北漂|记录)/u.test(t),
  },
  {
    // 认知提升：从最宽泛的"人生感悟与认知"兜底桶里切出"认知觉醒 / 自我觉醒 / 心力内核 / 国学哲学修心 / 刘晓艳式成长心态 / 财富认知"类。
    // 放在兜底之前、且关键词均与更专精度规则（财经/读书/商业）不冲突，避免抢硬金融/书单命中。
    // 关键词来源：folder-members.json 中"认知提升"夹真实 31 条成员的标题反推。
    folder: "认知提升",
    test: (t) =>
      /(认知觉醒|认知提升|认知差|财富认知|搞钱思维|刘晓艳|人生哲理|哲学|拒绝内耗|精神内耗|内耗|甲木|五行|向死而生|脱胎换骨|涅槃|找自己|内心平静|如何成为成熟的人|从恨到看见|慢性压力|自我觉醒|内核稳定|情绪稳定|保护能量|觉察|觉知)/u.test(t),
  },
];

function semanticFallback(t) {
  // 人生感悟与认知 是最宽泛的兜底：哲理、认知、国学、修心、自我成长、命运、价值观等
  return "人生感悟与认知";
}

/*
 * 自定义分类体系支持。
 *
 * 用户可提供一个 taxonomy JSON（通过 `draft --taxonomy <path>`），覆盖默认 13 类。
 * 文件格式（键=类别名，值=配置）：
 *   {
 *     "编程与技术": { "description": "代码、算法、后端", "keywords": ["编程","代码","算法","java"] },
 *     "我的兜底类": { "description": "未命中上述关键词时归入此类", "keywords": [], "fallback": true }
 *   }
 * 规则：
 *   - 每个类别的 keywords 用 `|` 拼成不区分大小写的正则（与 RULES 同机制）。
 *   - 标注 "fallback": true 的类别作为兜底（未命中任何关键词时归入），最多一个；缺省则回退到内置兜底"人生感悟与认知"。
 *   - 类别名最长 15 字（抖音限制），description 可选。
 */
export function loadTaxonomy(taxonomyPath) {
  if (!taxonomyPath) return null;
  const resolved = path.resolve(String(taxonomyPath));
  if (!fs.existsSync(resolved)) throw new Error(`Taxonomy file not found: ${resolved}`);
  const raw = readJson(resolved);
  const entries = Object.entries(raw || {});
  if (!entries.length) throw new Error(`Taxonomy file is empty: ${resolved}`);
  const rules = [];
  let fallbackName = null;
  for (const [name, cfg] of entries) {
    if ([...name].length > 15) throw new Error(`Taxonomy folder name exceeds 15 characters: ${name}`);
    const keywords = Array.isArray(cfg?.keywords) ? cfg.keywords.filter(Boolean).map(String) : [];
    if (keywords.length) {
      const pattern = new RegExp(keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "iu");
      rules.push({ folder: name, test: t => pattern.test(t), custom: true });
    }
    if (cfg?.fallback) {
      if (fallbackName) throw new Error(`Taxonomy has multiple fallback folders: ${fallbackName}, ${name}`);
      fallbackName = name;
    }
  }
  return { rules, fallbackName, source: resolved };
}

export function buildDraftPlan(source, options = {}) {
  const uncertainFolder = options.uncertainFolder || "待确认";
  const folderVisibility = options.folderVisibility || "private";
  const taxonomy = options.taxonomy || null; // { rules, fallbackName } | null
  const classify = (item) => {
    if (taxonomy) {
      const t = `${item.title || ""} ${item.author || ""}`.toLowerCase();
      for (const rule of taxonomy.rules) {
        if (rule.test(t)) {
          return { folder: rule.folder, confidence: 0.9, reason: `自定义分类命中：${rule.folder}`, evidence: [rule.folder], engine: "custom-taxonomy" };
        }
      }
      const fb = taxonomy.fallbackName || semanticFallback(t);
      return { folder: fb, confidence: 0.78, reason: `未命中自定义关键词，归入兜底类：${fb}`, evidence: [], engine: "custom-taxonomy" };
    }
    return classifyFavorite(item, { uncertainFolder, mode: options.mode || "ai" });
  };
  const assignments = source.favorites.map((item) => ({
    aweme_id: item.aweme_id,
    ...classify(item),
  }));
  const used = new Set(assignments.map((item) => item.folder));
  // 自定义模式：文件夹列表来自 taxonomy 键（仅保留实际用到的）；默认模式：来自 DEFAULT_TAXONOMY
  let folders;
  if (taxonomy) {
    const taxoRaw = readJson(taxonomy.source);
    folders = Object.entries(taxoRaw)
      .filter(([name]) => used.has(name))
      .map(([name, cfg]) => ({ name, description: cfg?.description || "", visibility: folderVisibility }));
  } else {
    folders = DEFAULT_TAXONOMY.filter((category) => used.has(category.name)).map(
      ({ name, description }) => ({ name, description, visibility: folderVisibility }),
    );
  }
  if (used.has(uncertainFolder)) {
    folders.push({ name: uncertainFolder, description: "证据不足或分类置信度较低，等待人工确认", visibility: folderVisibility });
  }
  const plan = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    generator: taxonomy ? "custom-taxonomy-v1" : "semantic-v1; AI-assisted semantic classification (no keyword counting)",
    source_sha256: source.source_sha256 || sha256(source.favorites),
    existing_folders: options.existingFolders || [],
    folders,
    assignments,
    approval: { status: "pending", token: null, approved_at: null },
  };
  return plan;
}

export function aiClassifyFavorite(favorite) {
  const t = `${favorite.title || ""} ${favorite.author || ""}`.toLowerCase();
  const title = favorite.title || "";
  for (const rule of RULES) {
    if (rule.test(t)) {
      return {
        folder: rule.folder,
        confidence: 0.9,
        reason: `语义命中：${rule.folder}`,
        evidence: [rule.folder],
        engine: "semantic-v1",
      };
    }
  }
  const folder = semanticFallback(t);
  return {
    folder,
    confidence: 0.78,
    reason: `未命中专精度规则，归入宽泛兜底类：${folder}`,
    evidence: [],
    engine: "semantic-v1",
  };
}

// 兼容旧接口：默认走语义分类器（不再使用关键词计数）。
export function classifyFavorite(favorite, { uncertainFolder = "待确认", mode = "ai" } = {}) {
  const result = aiClassifyFavorite(favorite);
  if (result.folder === "待确认" && uncertainFolder !== "待确认") {
    return { ...result, folder: uncertainFolder };
  }
  return result;
}

export function writeDraftPlan(runDirectory, options = {}) {
  const incrementalFile = path.join(runDirectory, "incremental-favorites.json");
  const source = readJson(fs.existsSync(incrementalFile) ? incrementalFile : path.join(runDirectory, "favorites.json"));
  const summaryFile = path.join(runDirectory, "incremental-summary.json");
  const summary = fs.existsSync(summaryFile) ? readJson(summaryFile) : null;
  const plan = buildDraftPlan(source, {
    ...options,
    existingFolders: options.existingFolders || summary?.existing_folders || [],
  });
  const file = path.join(runDirectory, "classification-plan.json");
  writeJson(file, plan);
  return { file, plan };
}
