import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../api/client';
import { EmptyState, PageCard, PageHeader } from '../../../components/Card';
import { asRecord, readString } from '../../workflow/format';
import styles from '../tasks.module.css';

/**
 * TD-05 专业审批。
 *
 * 能力事实（已核实，不是"数据为 0"）：
 * 13000 的插件清单里**没有** `plugin-approval` / `plugin-workflow-approval`
 * （`workflow-approval` 相关资源与动作都不存在），因此本页面只如实说明"能力未开通"，
 * 不放假入口、不自动启用插件、也不把人工处理节点冒充成专业审批。
 *
 * 页面会额外做一次**真实只读探测** `availableActions:list`（服务端返回当前环境可用的动作清单），
 * 用它说明"当前环境确实没有审批相关动作"，而不是只凭插件名缺失就下结论。
 */
interface ProbeState {
  status: 'loading' | 'done' | 'failed';
  approvals: string[];
  total: number | null;
}

export function ApprovalUnavailablePage() {
  const [probe, setProbe] = useState<ProbeState>({ status: 'loading', approvals: [], total: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const result = await api.resourceAction<unknown[]>('availableActions', 'list', {});
        const rows = Array.isArray(result.data) ? result.data : [];
        const approvals = rows
          .map((entry) => readString(entry, 'name') ?? readString(asRecord(entry)?.action, 'name') ?? '')
          .filter((name) => /approv/i.test(name));
        if (alive) setProbe({ status: 'done', approvals, total: rows.length });
      } catch {
        if (alive) setProbe({ status: 'failed', approvals: [], total: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="专业审批"
        description="这里本来是审批流程与审批记录的入口。"
        actions={
          <Link className={styles.secondaryButton} to="/tasks/pending">
            去处理待办
          </Link>
        }
      />
      <PageCard>
        <EmptyState
          tone="warn"
          title="当前环境没有开通专业审批能力"
          description={
            <span>
              这套系统当前安装的版本里没有审批插件，所以无法创建审批流程、也无法查看审批记录。
              这不是"暂时没有数据"，而是能力本身没有安装。
              <br />
              如果你的团队需要审批，请联系管理员评估安装对应插件后再使用；
              现有的<strong>人工处理节点</strong>已经可以在工作流里承担"提交内容 + 人工决定"的工作，
              可以在<Link className={styles.linkButton} to="/workflow/list">工作流 → 流程列表</Link>里查看。
            </span>
          }
        />
        <p className={styles.cellHint}>
          {probe.status === 'loading' ? '正在核对当前环境可用的功能…' : null}
          {probe.status === 'done'
            ? `当前环境共提供 ${probe.total ?? 0} 项可用功能，其中与审批相关的有 ${probe.approvals.length} 项。`
            : null}
          {probe.status === 'failed'
            ? '未能从服务端核对可用功能清单（可能是权限或网络原因），上面的结论来自已核实的插件清单。'
            : null}
        </p>
      </PageCard>
    </div>
  );
}
