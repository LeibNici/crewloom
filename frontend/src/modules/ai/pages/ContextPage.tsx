import { useState } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../../../components/Card';
import { DatasourceSection } from '../context/sections/DatasourceSection';
import { RecordSection } from '../context/sections/RecordSection';
import { CodeSection } from '../context/sections/CodeSection';
import { ChartSection } from '../context/sections/ChartSection';
import { SelectionSection } from '../context/sections/SelectionSection';
import { requestChatHandoff, useContextStoreSnapshot } from '../context/store';
import type { ContextKind } from '../context/types';
import styles from '../group-a.module.css';

/**
 * AI-04 任务与数据上下文。
 *
 * 四类上下文都用**真实 consumer**（报告 10 §2 的对照表）：
 *  - 数据范围 / 指定记录 → `datasource`（服务端 ACL 受控解析）；
 *  - 代码工作内容 → `code-editor`（服务端模板）+ 可选的真实 `datasource` 数据项；
 *  - 图表工作内容 → `chart-config`（客户端注册 + 默认 JSON 解析）。
 *
 * 页面文案只讲用户要做什么（选数据、挑记录、写代码、配图表，然后到会话里使用）：
 * 服务端策略、客户端注册、schema、前端工具这些实现概念不对普通用户展示（报告 10 §4）。
 */

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'datasource', label: '数据范围', hint: '保存并可复用的数据范围' },
  { key: 'record', label: '指定记录', hint: '明确挑一条记录' },
  { key: 'code', label: '代码工作内容', hint: '写代码并可附上用到的数据' },
  { key: 'chart', label: '图表工作内容', hint: '配置并预览图表' },
  { key: 'selection', label: '会话内容', hint: '这次要带上的内容' },
];

type TabKey = ContextKind | 'selection';

export function ContextPage() {
  const [tab, setTab] = useState<TabKey>('datasource');
  const snapshot = useContextStoreSnapshot();
  const selectionCount = snapshot.selections.length;

  return (
    <div className={styles.stack}>
      <PageHeader
        title="任务与数据上下文"
        description="给数字员工指定这次可以读取的内容：数据范围、某条记录、一段代码或一份图表。选好后到会话里发送。"
        actions={
          <Link className={styles.button} to="/ai/conversations" onClick={requestChatHandoff}>
            到会话中使用
          </Link>
        }
      />

      <div className={styles.chipRow} role="tablist" aria-label="上下文工作区">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? `${styles.chip} ${styles.chipActive}` : styles.chip}
            onClick={() => setTab(item.key)}
            title={item.hint}
            data-testid={`context-tab-${item.key}`}
          >
            {item.label}
            {item.key === 'selection' && selectionCount > 0 ? `（${selectionCount}）` : ''}
          </button>
        ))}
      </div>

      {tab === 'datasource' ? <DatasourceSection /> : null}
      {tab === 'record' ? <RecordSection /> : null}
      {tab === 'code' ? <CodeSection /> : null}
      {tab === 'chart' ? <ChartSection /> : null}
      {tab === 'selection' ? <SelectionSection onEdit={(kind) => setTab(kind)} /> : null}
    </div>
  );
}
