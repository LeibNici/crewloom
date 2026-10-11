/**
 * 受控工作流后端中间件（只在本机开发/预览服务器上、且显式开启时生效）。
 *
 * 作用：给**真实原生画布 UI** 提供一个本机的、可写的工作流后端，让
 * `workflows/<版本>/nodes:create`、`flow_nodes:create|update|move|duplicate|destroy|destroyBranch|test`
 * 这些**真实请求**由 UI 自己发出、在本机被应答，绝不落到真实 13000；
 * 真实实例只保留正常登录与精准只读。
 *
 * 覆盖的读：
 *   - `GET /api/workflows:get?filterByTk=<受控版本>`（appends nodes/stats/versionStats/...）
 *   - `GET /api/workflows:list`（filter.key = 受控 key 时返回受控版本列表，供版本切换）
 *   - `GET /api/flow_nodes:list`（filter.workflowId 为受控版本时返回受控节点）
 *   - `GET /api/flow_nodes:get?filterByTk=<受控节点>`
 *   - `GET /api/executions:list`（filter.workflowId 为受控版本时）
 *   - `GET /api/crewloomControlledWorkflow:state`（调试/证据：受控状态与请求日志）
 *
 * 覆盖的写（全部只改本进程内存，不写磁盘、不连真实后端）：
 *   - `POST /api/workflows/<id>/nodes:create`
 *   - `POST /api/flow_nodes:update|move|duplicate|destroy|destroyBranch|test`
 *   - `POST /api/crewloomControlledWorkflow:scenario`（设置下一次自测的受控应答：success/failure/permission/error）
 *
 * 与真实后端一致的规则也在这里实现，供 UI 验证"中文反馈"：
 *   - 已执行版本（`versionStats.executed > 0`）不可增删改：返回 400 + 中文 message；
 *   - 无权限：返回 403 + 中文 message（由 scenario 触发）；
 *   - 服务端错误：返回 500 + 中文 message。
 */

const CONTROLLED_KEY = 'crewloom-controlled-key';
const CONTROLLED_KEY_ALT = 'crewloom-controlled-other';

/**
 * 受控版本：
 *  - `draft` 可写；
 *  - `executed` 同一 key 的已执行版本（只读，用于 executed 限制）；
 *  - `other` 另一个逻辑流程（隔离用）；
 *  - `draft2` 与 `draft` **同 key 的第二个可编辑版本**（用于原生 header 的真实版本切换）；
 *  - `wide` 宽分支图（用于 390 窄屏左右分支可达性）。
 */
const DRAFT_ID = '900000000000001';
const EXECUTED_ID = '900000000000002';
const OTHER_ID = '900000000000003';
const DRAFT2_ID = '900000000000004';
const WIDE_ID = '900000000000005';
/**
 * 「分支 + 线性续行」样本。
 *
 * 真实 2.2.20 允许一个条件节点**同时**挂两条分支头和一条线性续行（汇合点）：
 * 服务端 `downstreamId` 指向唯一的 `branchIndex == null` 子节点，画布 `canvas/Branch.tsx:68`
 * 就是沿 `downstream` 一路渲染到续行。早期 fixture 的 `relink` 只在"恰好一个子节点"时写
 * `downstreamId`，无法表达这种真实图，导致产品把真实后端允许的整体上移/下移误禁用。
 */
const BRANCH_FLOW_ID = '900000000000006';

let nodeSeq = 910000;

const now = () => new Date().toISOString();

function makeNode(partial) {
  nodeSeq += 1;
  return {
    id: String(nodeSeq),
    key: `controlled-node-${nodeSeq}`,
    title: '',
    type: 'calculation',
    config: {},
    upstreamId: null,
    downstreamId: null,
    branchIndex: null,
    workflowId: DRAFT_ID,
    createdAt: now(),
    updatedAt: now(),
    ...partial,
  };
}

/** 受控流程库（内存单例；每次进程启动重置）。 */
function createStore() {
  const draftNodes = [
    makeNode({ title: '准备参数', type: 'calculation', config: { engine: 'math.js', expression: '1 + 1' } }),
    makeNode({ title: '是否需要处理', type: 'condition', config: { rejectOnFalse: false, engine: 'basic' } }),
    makeNode({ title: '处理结果', type: 'output', config: { value: 'done' } }),
    makeNode({ title: '跳过处理', type: 'output', config: { value: 'skipped' } }),
  ];
  // 线性 + 分支：A → B(否:B1 / 是:B2)
  const [a, b, c, d] = draftNodes;
  a.upstreamId = null;
  a.downstreamId = b.id;
  b.upstreamId = a.id;
  b.downstreamId = null;
  c.upstreamId = b.id;
  c.branchIndex = 0;
  d.upstreamId = b.id;
  d.branchIndex = 1;

  const versions = {
    [DRAFT_ID]: {
      id: DRAFT_ID,
      key: CONTROLLED_KEY,
      title: '受控流程（可编辑草稿）',
      type: 'collection',
      enabled: true,
      current: false,
      sync: false,
      executed: 0,
      description: '本机受控：用于验证原生画布的增删改与回读。',
      // 触发器配置：真实原生 `CollectionTrigger.useVariables` 会读 `config.collection`，
      // 缺了它配置抽屉渲染即抛错（实测 `Cannot read properties of undefined (reading 'collection')`）。
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      nodes: draftNodes,
    },
    [EXECUTED_ID]: {
      id: EXECUTED_ID,
      key: CONTROLLED_KEY,
      title: '受控流程（已有执行记录）',
      type: 'collection',
      enabled: true,
      current: true,
      sync: false,
      executed: 3,
      description: '本机受控：已执行版本，后端不允许修改（用于验证限制提示）。',
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 3 },
      stats: { executed: 3 },
      nodes: [makeNode({ title: '已执行节点', type: 'calculation', config: { expression: '2 + 2' } })].map((node) => ({
        ...node,
        workflowId: EXECUTED_ID,
      })),
    },
    [OTHER_ID]: {
      id: OTHER_ID,
      key: CONTROLLED_KEY_ALT,
      title: '受控流程（隔离样本）',
      type: 'collection',
      enabled: true,
      current: true,
      sync: false,
      executed: 0,
      description: '本机受控：独立流程，用于验证版本/执行隔离。',
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      nodes: [makeNode({ title: '隔离节点', type: 'output', config: { value: 'isolated' } })].map((node) => ({
        ...node,
        workflowId: OTHER_ID,
      })),
    },
    // 与 draft **同 key** 的第二个可编辑版本：用于原生 header 下拉的真实版本切换。
    [DRAFT2_ID]: {
      id: DRAFT2_ID,
      key: CONTROLLED_KEY,
      title: '受控流程（第二版草稿）',
      type: 'collection',
      enabled: true,
      current: false,
      sync: false,
      executed: 0,
      description: '本机受控：同一流程的第二个可编辑版本，用于版本切换/隔离验证。',
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      nodes: [
        makeNode({ title: '第二版·准备', type: 'calculation', config: { engine: 'math.js', expression: '7 * 6' } }),
        makeNode({ title: '第二版·输出', type: 'output', config: { value: 'v2' } }),
      ].map((node, index, list) => ({
        ...node,
        workflowId: DRAFT2_ID,
        upstreamId: index === 0 ? null : list[0].id,
        downstreamId: index === 0 ? list[1].id : null,
        branchIndex: null,
      })),
    },
    // 宽分支图：根 → 多条件分支（3 路），每路再挂 2 个节点，用于 390 下左右分支可达性，
    // 同时是「分支删除」唯一被真实原生契约支持的样本。
    [WIDE_ID]: {
      id: WIDE_ID,
      key: 'crewloom-controlled-wide',
      title: '受控流程（宽分支）',
      type: 'collection',
      enabled: true,
      current: true,
      sync: false,
      executed: 0,
      description: '本机受控：宽分支布局，用于窄屏下左右分支的可达性验证。',
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      nodes: (() => {
        const root = makeNode({ title: '宽·入口', type: 'calculation', config: { expression: '1 + 1' } });
        const branch = makeNode({
          title: '宽·三路分支',
          type: 'multi-conditions',
          // 真实原生 `multi-conditions` 的分支序号是 **0 = Otherwise（否则）+ 1..N = conditions[i-1]**
          // （`client-v2/nodes/components/multiConditionsShared.ts` 的 MULTI_CONDITION_BRANCH_INDEX，
          // 以及 `multi-conditions.tsx` 用 `branchIndex = index + 1` 渲染条件分支）。
          // 同时 `config.conditions` 的每一项带 `uid`（原生用 `key={item.uid}` 做 React key）。
          config: {
            conditions: [
              { uid: 'wide-cond-left', title: '左' },
              { uid: 'wide-cond-middle', title: '中' },
              { uid: 'wide-cond-right', title: '右' },
            ],
            continueOnNoMatch: false,
          },
        });
        root.upstreamId = null;
        root.downstreamId = branch.id;
        branch.upstreamId = root.id;
        const labels = [
          ['左', 1],
          ['中', 2],
          ['右', 3],
        ];
        const children = labels.flatMap(([label, branchIndex]) => {
          const head = makeNode({
            title: `宽·${label}路处理`,
            type: 'output',
            config: { value: label },
            upstreamId: branch.id,
            branchIndex,
          });
          const tail = makeNode({
            title: `宽·${label}路收尾`,
            type: 'output',
            config: { value: `${label}-end` },
            upstreamId: head.id,
            branchIndex: null,
          });
          head.downstreamId = tail.id;
          return [head, tail];
        });
        return [root, branch, ...children].map((node) => ({ ...node, workflowId: WIDE_ID }));
      })(),
    },
    /**
     * 「分支 + 线性续行」：`开始 → 准备 → 条件(否/是) → 合并 → 收尾`。
     *
     * 条件节点同时有两条分支头（branchIndex 0 / 1）与一条线性续行「合并」（branchIndex null），
     * `downstreamId` 指向「合并」。这是真实 2.2.20 允许、且真实画布会渲染的图；
     * 产品的主序列上下移必须在这种图上可用（整体交换条件与它前面的"准备"，分支归属与续行保持）。
     */
    [BRANCH_FLOW_ID]: {
      id: BRANCH_FLOW_ID,
      key: 'crewloom-controlled-branch-flow',
      title: '受控流程（分支+续行）',
      type: 'collection',
      enabled: true,
      current: true,
      sync: false,
      executed: 0,
      description: '本机受控：条件节点带两条处理路径 + 一条线性续行（汇合点），用于验证主序列上下移。',
      config: { collection: 'users', mode: 1 },
      versionStats: { executed: 0 },
      stats: { executed: 0 },
      nodes: (() => {
        const boot = makeNode({ title: '续行·开始', type: 'calculation', config: { expression: '1 + 1' } });
        const prepare = makeNode({ title: '续行·准备', type: 'calculation', config: { expression: '2 + 2' } });
        const condition = makeNode({
          title: '续行·是否需要处理',
          type: 'condition',
          config: { rejectOnFalse: false, engine: 'basic' },
        });
        const onFalse = makeNode({
          title: '续行·否侧处理',
          type: 'output',
          config: { value: 'no' },
          upstreamId: condition.id,
          branchIndex: 0,
        });
        const onTrue = makeNode({
          title: '续行·是侧处理',
          type: 'output',
          config: { value: 'yes' },
          upstreamId: condition.id,
          branchIndex: 1,
        });
        const merge = makeNode({
          title: '续行·合并',
          type: 'output',
          config: { value: 'merged' },
          upstreamId: condition.id,
        });
        const tail = makeNode({ title: '续行·收尾', type: 'output', config: { value: 'tail' }, upstreamId: merge.id });
        boot.upstreamId = null;
        boot.downstreamId = prepare.id;
        prepare.upstreamId = boot.id;
        prepare.downstreamId = condition.id;
        condition.upstreamId = prepare.id;
        // 分支头不进 downstreamId；条件之后是线性续行「合并」。
        condition.downstreamId = merge.id;
        merge.downstreamId = tail.id;
        return [boot, prepare, condition, onFalse, onTrue, merge, tail].map((node) => ({
          ...node,
          workflowId: BRANCH_FLOW_ID,
        }));
      })(),
    },
  };

  return {
    versions,
    /**
     * 受控执行（用于 WF-05 的 executionId 隔离：两次执行的 job 数不同，且与"全局"分开）。
     * 它们只服务本机受控后端，不代表真实 13000 的任何业务记录。
     */
    executions: {
      '920001': {
        id: '920001',
        workflowId: EXECUTED_ID,
        status: 1,
        jobs: [1, 2].map((index) => makeNode({ title: `受控 job ${index}`, type: 'output' })).map((node, index) => ({
          id: `93${String(920001).slice(2)}${index + 1}`,
          executionId: '920001',
          nodeId: node.id,
          nodeKey: node.key,
          status: 1,
          result: { controlled: true, index },
        })),
      },
      '920002': {
        id: '920002',
        workflowId: EXECUTED_ID,
        status: 1,
        jobs: [1, 2, 3, 4].map((index) => makeNode({ title: `受控 job ${index}`, type: 'output' })).map((node, index) => ({
          id: `93${String(920002).slice(2)}${index + 1}`,
          executionId: '920002',
          nodeId: node.id,
          nodeKey: node.key,
          status: 1,
          result: { controlled: true, index },
        })),
      },
    },
    /** 请求日志：UI 发出的每个受控请求都记录（用于"UI 真的发了请求"证据）。 */
    journal: [],
    /** 下一次 `flow_nodes:test` 的受控应答。 */
    testScenario: 'success',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ __raw: raw });
      }
    });
  });
}

function sendJson(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-crewloom-controlled', '1');
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, { errors: [{ code, message }] }, status);
}

/**
 * 规范化 appends。
 *
 * 原生 SDK 用 **数组记法**（`appends[]=nodes`）而不是逗号串，`searchParams.get('appends')`
 * 在那种请求上返回 null（实测：画布因此拿不到 `nodes`，节点数为 0）。这里把三种记法都收齐。
 */
function readAppends(searchParams) {
  const values = [...searchParams.getAll('appends'), ...searchParams.getAll('appends[]')];
  for (const [key, value] of searchParams.entries()) {
    if (/^appends\[\d+\]$/.test(key)) values.push(value);
  }
  return values.flatMap((value) => String(value).split(',')).filter(Boolean);
}

function versionPayload(version, searchParams) {
  const payload = { ...version };
  delete payload.nodes;
  const appendList = readAppends(searchParams);
  if (appendList.includes('nodes')) payload.nodes = version.nodes.map((node) => ({ ...node }));
  if (!appendList.includes('stats')) delete payload.stats;
  if (!appendList.includes('versionStats')) delete payload.versionStats;
  return payload;
}

function parseFilter(url) {
  const raw = new URL(url, 'http://127.0.0.1').searchParams.get('filter');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function linkDraft(nodes) {
  for (const node of nodes) {
    node.downstreamId = null;
  }
  for (const node of nodes) {
    if (node.upstreamId === null || node.upstreamId === undefined) continue;
    const upstream = nodes.find((item) => item.id === String(node.upstreamId));
    if (!upstream) {
      node.upstreamId = null;
      continue;
    }
    if (upstream.downstreamId === null || upstream.downstreamId === undefined) {
      upstream.downstreamId = node.id;
      node.branchIndex = null;
    }
  }
}

/**
 * 把节点按真实 2.2.20 服务端的链表规则**插入**流程（`server/actions/nodes.ts` 的
 * `create` / `duplicate` 共用同一段插入逻辑，`move` 的落位也一致）：
 *
 *  - `upstreamId == null`：插到流程最前，原来的头节点变成它的下游；
 *  - `branchIndex == null`：插在 `upstreamId` 与它**当前下游**之间；
 *  - `branchIndex != null`：作为该上游第 `branchIndex` 条分支的头；该位置已有分支头时，
 *    原分支头变成新节点的下游并清空自己的 `branchIndex`。
 *
 * 只维护 `upstreamId` / `downstreamId` / `branchIndex` 三个指针；`title`/`config` 等由调用方负责。
 * 这段语义是"复制后画布断链"的根因所在（只按节点数 +1 断言成功会漏掉它），因此照上游逐支实现。
 */
function insertIntoChain(version, node) {
  const nodes = version.nodes;
  if (node.upstreamId == null) {
    const previousHead = nodes.find((item) => item.id !== node.id && item.upstreamId == null);
    if (previousHead) {
      previousHead.upstreamId = node.id;
      node.downstreamId = previousHead.id;
    } else {
      node.downstreamId = null;
    }
    return;
  }
  const upstream = nodes.find((item) => item.id === String(node.upstreamId));
  if (!upstream) {
    node.upstreamId = null;
    node.downstreamId = null;
    return;
  }
  if (node.branchIndex == null) {
    const downstream = nodes.find((item) => item.id === upstream.downstreamId);
    if (downstream) {
      downstream.upstreamId = node.id;
      node.downstreamId = downstream.id;
    } else {
      node.downstreamId = null;
    }
    upstream.downstreamId = node.id;
    return;
  }
  const branchHead = nodes.find(
    (item) => item.id !== node.id && item.upstreamId === upstream.id && item.branchIndex === node.branchIndex,
  );
  if (branchHead) {
    branchHead.upstreamId = node.id;
    branchHead.branchIndex = null;
    node.downstreamId = branchHead.id;
  } else {
    node.downstreamId = null;
  }
}

/**
 * 从一个节点出发，收集它作为**分支头**的上游所挂的全部分支节点子树
 * （逐字对应上游 `server/actions/nodes.ts` 的 `searchBranchNodes` / `searchBranchDownstreams`）。
 *
 * 用于 `flow_nodes:destroy`：真实后端删除一个带分支的节点时，会连同它的分支子树一起删除，
 * 而不是把分支节点重新接回被删节点的上游。
 */
function searchBranchNodes(nodes, from) {
  const branchHeads = nodes.filter((item) => item.upstreamId === from.id && item.branchIndex != null);
  return branchHeads.reduce((flatten, head) => flatten.concat(searchBranchDownstreams(nodes, head)), []);
}

function searchBranchDownstreams(nodes, from) {
  let result = [];
  for (let search = from; search; search = nodes.find((item) => item.id === search.downstreamId)) {
    result = [...result, search, ...searchBranchNodes(nodes, search)];
  }
  return result;
}

/**
 * 重算 `downstreamId`。
 *
 * 真实 2.2.20 的 `downstreamId` 指向**唯一的线性子节点**（`branchIndex == null`）：
 *  - 普通线性节点：它的下一个节点；
 *  - **分支父节点**（条件 / 多条件 / 循环 / 并行）：分支头（`branchIndex != null`）不进
 *    `downstreamId`，而分支之后的**线性续行（汇合点）**要进——真实画布 `canvas/Branch.tsx:68`
 *    就是 `for (let node = entry; node; node = node.downstream)` 一路渲染到续行。
 *
 * 早期实现只在"恰好一个子节点"时才写 `downstreamId`，于是"分支 + 续行"的节点（子节点数 > 1）
 * 永远拿不到 `downstreamId`，本机 fixture 无法表达真实后端**允许**的图。这里按真实语义修正：
 * 只看**线性子节点**是否恰好一个。
 *
 * 对既有受控版本是严格兼容的：那些节点的父节点要么只有分支头、要么只有一个线性子节点。
 */
function relink(version) {
  const nodes = version.nodes;
  for (const node of nodes) node.downstreamId = null;
  const byUpstream = new Map();
  for (const node of nodes) {
    if (node.upstreamId == null) continue;
    const list = byUpstream.get(String(node.upstreamId)) ?? [];
    list.push(node);
    byUpstream.set(String(node.upstreamId), list);
  }
  for (const [upstreamId, children] of byUpstream.entries()) {
    const upstream = nodes.find((item) => item.id === upstreamId);
    if (!upstream) continue;
    const linearChildren = children.filter((child) => child.branchIndex === null || child.branchIndex === undefined);
    if (linearChildren.length === 1) upstream.downstreamId = linearChildren[0].id;
  }
}

export function createControlledWorkflowMiddleware(options = {}) {
  const store = options.store ?? createStore();

  function executedGuard(version, res) {
    const executed = Number(version?.versionStats?.executed ?? version?.executed ?? 0);
    if (executed > 0) {
      sendError(
        res,
        400,
        'WORKFLOW_VERSION_EXECUTED',
        '这个版本已经有执行记录，不能再修改节点或流程配置；请先新建版本。',
      );
      return true;
    }
    return false;
  }

  return async function controlledWorkflowMiddleware(req, res, next) {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return next();
    const pathname = url.split('?')[0];
    const action = pathname.slice('/api/'.length);
    const method = (req.method ?? 'GET').toUpperCase();
    const filter = parseFilter(url);

    // ---- 调试/证据端点（受控专用，不代理） ----
    if (action === 'crewloomControlledWorkflow:state' && method === 'GET') {
      sendJson(res, {
        data: {
          draftId: DRAFT_ID,
          executedId: EXECUTED_ID,
          otherId: OTHER_ID,
          draft2Id: DRAFT2_ID,
          wideId: WIDE_ID,
          key: CONTROLLED_KEY,
          testScenario: store.testScenario,
          versions: Object.values(store.versions).map((version) => ({
            id: version.id,
            key: version.key,
            current: version.current,
            executed: version.versionStats.executed,
            nodeCount: version.nodes.length,
          })),
          nodes: store.versions[DRAFT_ID].nodes.map((node) => ({ ...node })),
          // 每个版本的节点（版本切换隔离验证需要看"另一个版本"的节点是否被误改）。
          versionNodes: Object.fromEntries(
            Object.values(store.versions).map((version) => [version.id, version.nodes.map((node) => ({ ...node }))]),
          ),
          executions: Object.fromEntries(
            Object.entries(store.executions).map(([id, execution]) => [
              id,
              { id: execution.id, workflowId: execution.workflowId, jobs: execution.jobs.map((job) => ({ ...job })) },
            ]),
          ),
          journal: store.journal.slice(),
        },
      });
      return;
    }
    if (action === 'crewloomControlledWorkflow:scenario' && method === 'POST') {
      const body = await readBody(req);
      if (['success', 'failure', 'permission', 'error'].includes(body?.test)) {
        store.testScenario = body.test;
      }
      sendJson(res, { data: { testScenario: store.testScenario } });
      return;
    }
    if (action === 'crewloomControlledWorkflow:reset' && method === 'POST') {
      const fresh = createStore();
      for (const key of Object.keys(store)) delete store[key];
      Object.assign(store, fresh);
      sendJson(res, { data: { reset: true } });
      return;
    }

    const isControlledNode = (id) =>
      Object.values(store.versions).some((version) => version.nodes.some((node) => node.id === String(id)));

    const journal = (entry) => {
      store.journal.push({ at: now(), ...entry });
      if (store.journal.length > 400) store.journal.shift();
    };

    // ---- 读：workflows:get ----
    if (action === 'workflows:get' && method === 'GET') {
      const searchParams = new URL(url, 'http://127.0.0.1').searchParams;
      const id = String(searchParams.get('filterByTk') ?? '');
      const version = store.versions[id];
      if (!version) return next();
      journal({ method, action, filterByTk: id, controlled: true });
      sendJson(res, { data: versionPayload(version, searchParams) });
      return;
    }

    // ---- 读：workflows:list（受控 key / id 过滤时） ----
    if (action === 'workflows:list' && method === 'GET') {
      const keyFilter = filter?.key;
      const idFilter = filter?.id;
      const wanted =
        (typeof keyFilter === 'string' && (keyFilter === CONTROLLED_KEY || keyFilter === CONTROLLED_KEY_ALT)) ||
        (idFilter !== undefined && store.versions[String(idFilter)] !== undefined);
      if (!wanted) return next();
      journal({ method, action, filter, controlled: true });
      const rows = Object.values(store.versions)
        .filter((version) => (keyFilter ? version.key === keyFilter : String(version.id) === String(idFilter)))
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((version) => versionPayload(version, new URLSearchParams([['appends[]', 'versionStats']])));
      sendJson(res, { data: rows, meta: { count: rows.length, page: 1, pageSize: rows.length, totalPage: 1 } });
      return;
    }

    // ---- 读：flow_nodes:list / get ----
    if (action === 'flow_nodes:list' && method === 'GET') {
      const workflowId = filter?.workflowId;
      const version = workflowId !== undefined ? store.versions[String(workflowId)] : undefined;
      if (!version) return next();
      journal({ method, action, filter, controlled: true, rows: version.nodes.length });
      sendJson(res, {
        data: version.nodes.map((node) => ({ ...node })),
        meta: { count: version.nodes.length, page: 1, pageSize: version.nodes.length, totalPage: 1 },
      });
      return;
    }
    if (action === 'flow_nodes:get' && method === 'GET') {
      const id = String(new URL(url, 'http://127.0.0.1').searchParams.get('filterByTk') ?? '');
      const found = Object.values(store.versions)
        .flatMap((version) => version.nodes)
        .find((node) => node.id === id);
      if (!found) return next();
      journal({ method, action, filterByTk: id, controlled: true });
      sendJson(res, { data: { ...found } });
      return;
    }

    // ---- 读：executions:list（受控流程） ----
    if (action === 'executions:list' && method === 'GET') {
      const workflowId = filter?.workflowId;
      if (workflowId === undefined || !store.versions[String(workflowId)]) return next();
      const rows = Object.values(store.executions)
        .filter((execution) => execution.workflowId === String(workflowId))
        .map((execution) => ({
          id: execution.id,
          workflowId: execution.workflowId,
          status: execution.status,
          reason: null,
          createdAt: now(),
          updatedAt: now(),
          startedAt: now(),
          finishedAt: now(),
        }));
      journal({ method, action, filter, controlled: true, rows: rows.length });
      sendJson(res, { data: rows, meta: { count: rows.length, page: 1, pageSize: 20, totalPage: 1 } });
      return;
    }

    // ---- 读：jobs:list（受控执行隔离：全局 vs 按 executionId 过滤） ----
    if (action === 'jobs:list' && method === 'GET') {
      const all = Object.values(store.executions).flatMap((execution) =>
        execution.jobs.map((job) => ({ ...job })),
      );
      const executionId = filter?.executionId;
      // 不带 filter 时**不拦截**（真实实例的全局 jobs 统计由真实只读核对回答）；
      // 只有明确按受控 executionId 过滤时才本机应答，避免掩盖真实全局口径。
      if (executionId === undefined || !store.executions[String(executionId)]) {
        if (Object.keys(filter ?? {}).length === 0) {
          journal({ method, action, filter, controlled: true, rows: all.length, scope: 'controlled-global' });
          sendJson(res, { data: all, meta: { count: all.length, page: 1, pageSize: 200, totalPage: 1 } });
          return;
        }
        return next();
      }
      const execution = store.executions[String(executionId)];
      journal({ method, action, filter, controlled: true, rows: execution.jobs.length, scope: 'execution' });
      sendJson(res, {
        data: execution.jobs.map((job) => ({ ...job })),
        meta: { count: execution.jobs.length, page: 1, pageSize: 200, totalPage: 1 },
      });
      return;
    }

    // ---- 写：workflows/<id>/nodes:create（原生新增节点的真实路径） ----
    const createMatch = /^workflows\/([^/]+)\/nodes:create$/.exec(action);
    if (createMatch && method === 'POST') {
      const version = store.versions[createMatch[1]];
      if (!version) return next();
      const body = await readBody(req);
      journal({ method, action, controlled: true, payload: body });
      if (executedGuard(version, res)) return;
      // 原生 SDK 的 `resource(...).create({ values })` 把 `values` **直接**作为请求体
      // （`APIClient.js`：`const { values, filter, ...others } = params; config.data = values`），
      // 因此这里以 body 为准，同时兼容 `{ values }` 包装。
      const values = body?.values ?? body ?? {};
      const node = makeNode({
        title: values.title ?? '',
        type: values.type ?? 'calculation',
        config: values.config ?? {},
        upstreamId: values.upstreamId ?? null,
        branchIndex: values.branchIndex ?? null,
        workflowId: version.id,
      });
      version.nodes.push(node);
      // 与真实 `create` 一致：按 `upstreamId`/`branchIndex` 插进链表，并维护两侧指针。
      insertIntoChain(version, node);
      relink(version);
      sendJson(res, { data: { ...node } }, 200);
      return;
    }

    // ---- 写：flow_nodes:* ----
    if (action.startsWith('flow_nodes:') && method === 'POST') {
      const body = await readBody(req);
      const searchParams = new URL(url, 'http://127.0.0.1').searchParams;
      // 原生 SDK 把 `filterByTk` 放在**查询串**、`values` 作为请求体
      // （`APIClient.js`：`const { values, filter, ...others } = params; config.params = others; config.data = values`）。
      const filterByTk = String(searchParams.get('filterByTk') ?? body?.filterByTk ?? '');
      const values = body?.values ?? body ?? {};

      // `flow_nodes:test` 是集合级动作（原生调用不带 filterByTk）：受控模式下直接由本机应答，
      // 绝不落到真实后端（服务端守卫仍会拦非受控模式下的同名请求）。
      if (action === 'flow_nodes:test') {
        journal({ method, action, controlled: true, payload: body, scenario: store.testScenario });
        const scenario = store.testScenario;
        if (scenario === 'permission') {
          sendError(res, 403, 'FORBIDDEN', '当前账号没有执行该节点的权限，请联系管理员分配权限。');
          return;
        }
        if (scenario === 'error') {
          sendError(res, 500, 'INTERNAL_ERROR', '节点执行时发生内部错误，请稍后重试或联系管理员。');
          return;
        }
        if (scenario === 'failure') {
          // 原生 `TestRunButton` 读的是 `response.data.data`（axios response → 服务端 JSON 的 data 字段），
          // 所以真实服务端形状是**单层** `{ data: { status, result, log } }`（实测：写成双层会渲染"失败"）。
          sendJson(res, {
            data: { status: -1, result: null, log: '受控失败：表达式求值失败（本机受控应答，未执行真实流程）。' },
          });
          return;
        }
        sendJson(res, {
          data: {
            status: 1,
            result: {
              controlled: true,
              // 回显 UI 真实提交的节点类型与配置：用于证明"自测跑的就是画布里选中的那个节点/面板"
              // （原生 `TestRunButton` 发的是 `values.{config,type}`，见
              // `plugin-workflow/src/client-v2/components/TestRunButton.tsx:130-133`）。
              type: values?.type ?? null,
              config: values?.config ?? null,
              value: values?.config?.expression ?? 'ok',
            },
            log: '受控成功：本机受控应答，未执行真实流程，也未外呼模型。',
          },
        });
        return;
      }

      const version = Object.values(store.versions).find((item) =>
        item.nodes.some((node) => node.id === filterByTk),
      );
      if (!version) return next();
      journal({ method, action, filterByTk, controlled: true, payload: body });
      if (executedGuard(version, res)) return;

      const node = version.nodes.find((item) => item.id === filterByTk);

      if (action === 'flow_nodes:update') {
        if (typeof values.title === 'string') node.title = values.title;
        if (values.config !== undefined) node.config = values.config;
        if (values.branchIndex !== undefined) node.branchIndex = values.branchIndex;
        if (values.upstream && typeof values.upstream === 'object' && 'id' in values.upstream) {
          node.upstreamId = values.upstream.id === null ? null : String(values.upstream.id);
        }
        node.updatedAt = now();
        relink(version);
        sendJson(res, { data: { ...node } });
        return;
      }

      if (action === 'flow_nodes:move') {
        // 逐支对应真实 `server/actions/nodes.ts` 的 `move`：先解开旧位置，再按新位置插链。
        // `branchIndex` 只在给了 `upstreamId` 时有效；接到自己后面、以及位置没变化都会 400。
        const upstreamId =
          values.upstreamId === null || values.upstreamId === undefined || values.upstreamId === ''
            ? null
            : String(values.upstreamId);
        let branchIndex =
          values.branchIndex === null || values.branchIndex === undefined || values.branchIndex === ''
            ? null
            : Number(values.branchIndex);
        if (upstreamId === null) branchIndex = null;
        if (upstreamId !== null && upstreamId === node.id) {
          sendError(res, 400, 'INVALID_UPSTREAM_NODE', 'Invalid upstream node');
          return;
        }
        if ((node.upstreamId ?? null) === upstreamId && (node.branchIndex ?? null) === branchIndex) {
          sendError(res, 400, 'NODE_NOT_MOVED', 'Node does not need to be moved');
          return;
        }
        const oldUpstream = version.nodes.find((item) => item.id === node.upstreamId) ?? null;
        const oldDownstream = version.nodes.find((item) => item.id === node.downstreamId) ?? null;
        if (oldUpstream && oldUpstream.downstreamId === node.id) {
          oldUpstream.downstreamId = oldDownstream ? oldDownstream.id : null;
        }
        if (oldDownstream && oldDownstream.upstreamId === node.id) {
          oldDownstream.upstreamId = oldUpstream ? oldUpstream.id : null;
          oldDownstream.branchIndex = node.branchIndex ?? null;
        }
        node.upstreamId = upstreamId;
        node.branchIndex = branchIndex;
        node.downstreamId = null;
        node.updatedAt = now();
        insertIntoChain(version, node);
        relink(version);
        sendJson(res, { data: { ...node } });
        return;
      }

      if (action === 'flow_nodes:duplicate') {
        // 逐支对应真实 `duplicate`：复制 `type/title/config`；位置**只**由 `values.upstreamId` /
        // `values.branchIndex` 决定。`values` 里不给位置时，上游服务端会按 `upstreamId=null`
        // **插到流程最前**（`server/actions/nodes.ts:172-198`），不是"接在被复制节点之后"——
        // 这正是"复制后画布只剩一个节点"的根因；只断言节点数 +1 会漏掉它。
        const clone = makeNode({
          title: node.title,
          type: node.type,
          config:
            values.config !== undefined
              ? JSON.parse(JSON.stringify(values.config))
              : JSON.parse(JSON.stringify(node.config ?? {})),
          upstreamId:
            values.upstreamId === null || values.upstreamId === undefined || values.upstreamId === ''
              ? null
              : String(values.upstreamId),
          branchIndex:
            values.branchIndex === null || values.branchIndex === undefined || values.branchIndex === ''
              ? null
              : Number(values.branchIndex),
          workflowId: version.id,
        });
        version.nodes.push(clone);
        insertIntoChain(version, clone);
        relink(version);
        sendJson(res, { data: { ...clone } });
        return;
      }

      if (action === 'flow_nodes:destroy') {
        // 与真实 `destroy` 一致：上下游互接；**带分支的节点连同分支子树一起删除**。
        const upstream = version.nodes.find((item) => item.id === node.upstreamId) ?? null;
        const downstream = version.nodes.find((item) => item.id === node.downstreamId) ?? null;
        const branchNodes = searchBranchNodes(version.nodes, node);
        const removed = [node.id, ...branchNodes.map((item) => item.id)];
        if (upstream && upstream.downstreamId === node.id) {
          upstream.downstreamId = downstream ? downstream.id : null;
        }
        if (downstream) {
          downstream.upstreamId = node.upstreamId ?? null;
          downstream.branchIndex = node.branchIndex ?? null;
        }
        version.nodes = version.nodes.filter((item) => !removed.includes(item.id));
        relink(version);
        sendJson(res, { data: { id: node.id, deleted: true, removed } });
        return;
      }

      if (action === 'flow_nodes:destroyBranch') {
        // 与真实 `destroyBranch` 一致：`filterByTk` 是**分支挂靠的上游节点**，`branchIndex` 必填，
        // `shift=1` 时把更高序号的分支整体前移（原生 `multi-conditions.tsx:218-222` 就是这么调的）。
        const branchIndexParam = searchParams.get('branchIndex') ?? values.branchIndex;
        if (branchIndexParam == null || branchIndexParam === '') {
          sendError(res, 400, 'BRANCH_INDEX_REQUIRED', 'branchIndex is required');
          return;
        }
        const branchIndex = Number.parseInt(String(branchIndexParam), 10);
        if (Number.isNaN(branchIndex)) {
          sendError(res, 400, 'BRANCH_INDEX_INVALID', 'branchIndex must be a number');
          return;
        }
        const shiftParam = searchParams.get('shift') ?? values.shift;
        const shift = shiftParam != null && shiftParam !== '' && Number.parseInt(String(shiftParam), 10) === 1;
        const branchHeads = version.nodes
          .filter((item) => item.upstreamId === node.id && item.branchIndex != null)
          .sort((a, b) => a.branchIndex - b.branchIndex);
        const branchHead = branchHeads.find((item) => item.branchIndex === branchIndex) ?? null;
        let removed = [];
        if (branchHead) {
          removed = searchBranchDownstreams(version.nodes, branchHead).map((item) => item.id);
          version.nodes = version.nodes.filter((item) => !removed.includes(item.id));
        }
        if (shift) {
          for (const head of branchHeads) {
            if (head.branchIndex > branchIndex) head.branchIndex -= 1;
          }
        }
        relink(version);
        sendJson(res, { data: branchHead ? { ...branchHead, removed } : null });
        return;
      }
    }

    return next();
  };
}

export const CONTROLLED_WORKFLOW_IDS = {
  DRAFT_ID,
  EXECUTED_ID,
  OTHER_ID,
  DRAFT2_ID,
  WIDE_ID,
  BRANCH_FLOW_ID,
  CONTROLLED_KEY,
  CONTROLLED_KEY_ALT,
};

/**
 * 供**独立的本机合成后端**（`scripts/main-browser-workflow-server.mjs`）复用同一套受控状态机：
 * 它需要持有同一个 store 来做"列表/分页/创建/复制/启停/执行详情"等中间件之外的读写，
 * 并复用 `readAppends` / `versionPayload` 保证 `appends[]` 记法与 `stats`/`versionStats` 的
 * 裁剪语义与中间件**逐字一致**（否则列表页与画布页会看到两种形状）。
 *
 * 只做导出，不改变任何既有行为。
 */
export { createStore as createControlledWorkflowStore, readAppends, versionPayload, makeNode };
