import { useQuery } from '@tanstack/react-query';
import { PageCard, PageHeader, StatusPill } from '../../../components/Card';
import { api } from '../../../api/client';
import { Notice, StateBlock } from '../ui';
import styles from '../group-a.module.css';

/**
 * AI-06 知识库 —— **能力未开通**。
 *
 * 依据（报告 01 §2、DC-4）：13000 的 98 个插件名单里**没有** `ai-knowledge-base`，
 * 因此关联文档、检索与检索测试都没有可用接口。这是**真正缺失的能力**，与
 * "数据为 0"（例如 MCP 配置为空）必须分开表达。
 *
 * 本页不做假入口、不显示假数据，也不自动安装或启用插件；同时保留对未来入口的说明，
 * 便于能力具备后直接接上。
 */

export function KnowledgePage() {
  /**
   * 只做一次"能力是否出现"的只读探测：知识库相关的集合/资源在该实例上不存在。
   * 这里不猜测集合名就发请求，而是通过集合列表确认——集合列表是当前账号可读的。
   */
  const collections = useQuery({
    queryKey: ['ai', 'knowledge', 'capability-probe'],
    queryFn: async () => {
      const result = await api.resourceAction<Array<Record<string, unknown>>>('collections', 'list', {
        params: { pageSize: 400 },
      });
      return Array.isArray(result.data) ? result.data : [];
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  const names = (collections.data ?? [])
    .map((row) => (typeof row.name === 'string' ? row.name.toLowerCase() : ''))
    .filter((name) => name.length > 0);
  const related = names.filter((name) => name.includes('knowledge'));

  return (
    <div className={styles.stack}>
      <PageHeader
        title="知识库"
        description="知识库相关能力在当前环境上不可用；这里如实说明现状，不提供无法工作的入口。"
      />

      <PageCard title="当前状态">
        <div className={styles.chipRow} style={{ marginBottom: 12 }}>
          <StatusPill tone="warn">能力未开通</StatusPill>
        </div>
        <Notice tone="warn">
          当前环境没有开通知识库能力，因此无法创建知识库、上传文档、做检索或检索测试。
          这是能力本身缺失，而不是"数据为空"或"权限不足"。
        </Notice>
        <div className={styles.rowList} style={{ marginTop: 12 }}>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>为什么不可用</span>
              <span className={styles.rowHint}>
                当前环境没有提供知识库所需的数据与服务，前端即使做出界面也无法工作。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>和"数据为 0"的区别</span>
              <span className={styles.rowHint}>
                例如 MCP 连接列表在同样为空时是"配置为空、能力可用"；知识库是"能力未开通"。两者在界面上必须分开表达。
              </span>
            </div>
          </div>
          <div className={styles.rowCard}>
            <div className={styles.rowMain}>
              <span className={styles.rowTitle}>接下来的入口</span>
              <span className={styles.rowHint}>
                环境开通该能力后，本页会改为真实的库、文档、检索与检索测试入口；
                员工配置里的知识库关联项也会一并启用。
              </span>
            </div>
          </div>
        </div>
      </PageCard>

      <PageCard
        title="能力核实"
        description="只做只读核对：确认当前环境是否已经提供知识库能力。"
      >
        <StateBlock
          state={collections.isLoading ? 'loading' : collections.error ? 'error' : 'ready'}
          message={collections.error ? '暂时无法完成核实，请稍后重试。' : null}
          onRetry={() => void collections.refetch()}
          emptyTitle="暂时无法完成核实"
        />
        {!collections.isLoading && !collections.error ? (
          related.length > 0 ? (
            <Notice>已发现知识库相关内容，刷新本页可重新核实。</Notice>
          ) : (
            <Notice>
              没有发现知识库能力。若后续管理员开通了该能力，刷新本页即可重新核实。
            </Notice>
          )
        ) : null}
      </PageCard>
    </div>
  );
}
