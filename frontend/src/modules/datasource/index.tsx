import { accessCheck, defineModule } from '../types';
import { AccessPage } from './pages/AccessPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { DatasourceDetailPage } from './pages/DatasourceDetailPage';
import { DatasourceListPage } from './pages/DatasourceListPage';
import { CollectionRecordsPage, PreviewPage } from './pages/PreviewPage';
import { TablesPage } from './pages/TablesPage';

/**
 * 数据源模块（DS-01 … DS-05）——**组 B（DS + AC）独占文件**。
 *
 * 13000 实测约束（详见 group-b-evidence/live-metadata-discovery*.json）：
 *  - 只有 `main` 一个数据源（`dataSources:list` 返回 1 条，`listEnabled` 为 0）；
 *    main 是内建固定数据源，不在 listEnabled 里**不代表不可用**；
 *  - 当前实例未安装外部连接器插件 → DS-02 的外部类型确实不可用，按能力未开通呈现，不伪造类型清单；
 *  - 主数据源有 157 个业务集合；集合与字段用真实 schema（`collections` / `collections/<name>/fields`），
 *    不从记录响应键推断表结构；插件集合不在业务集合管理器里（`collections:get` 返回 null）；
 *  - `dataSources:readTables` / `loadTables` / `testConnection` 会访问真实数据源（POST 但语义接近读取），
 *    只登记为产品动作，只有真实用户主动点击才发出；strict 自动验证一律拦截；
 *  - 业务集合记录读写走 `<collection>:list|get|create|update|destroy`（带 `X-Data-Source`），后端 ACL 判定。
 */
export const datasourceModule = defineModule({
  id: 'datasource',
  title: '数据源',
  path: '/datasource',
  subtitle: '连接、数据结构与访问授权',
  access: accessCheck('datasource.read', '查看数据源', 'dataSources', 'list'),
  probeId: 'datasource.read',
  boards: [
    {
      path: 'list',
      title: '数据源列表',
      description: '主数据源与外部连接的启用、加载状态；外部连接能力未开通时如实说明。',
      access: accessCheck('datasource.list', '查看数据源列表', 'dataSources', 'list'),
      probeId: 'datasource.read',
      endpoints: ['dataSources:list', 'dataSources:listEnabled', 'dataSources:get'],
      Component: DatasourceListPage,
    },
    {
      path: 'list/:key',
      title: '连接配置',
      description: '单个数据源的详情；外部连接可维护连接选项与测试连接（会真实建连）。',
      access: accessCheck('datasource.detail', '查看数据源详情', 'dataSources', 'get'),
      probeId: 'datasource.read',
      endpoints: ['dataSources:get', 'dataSources:update', 'dataSources:testConnection', 'collections:list'],
      Component: DatasourceDetailPage,
    },
    {
      path: 'tables',
      title: '数据表与字段',
      description: '来自主库的业务集合清单；点开维护字段、关联与反向同步。',
      access: accessCheck('datasource.tables', '查看数据表', 'collections', 'list'),
      probeId: 'datasource.read',
      endpoints: ['collections:list', 'collections:create', 'collections:update', 'collections:destroy'],
      Component: TablesPage,
    },
    {
      path: 'tables/:collectionName',
      title: '集合字段',
      description: '集合的字段与关联定义；字段增改删、反向同步与物理表加载。',
      access: accessCheck('datasource.collection', '查看集合字段', 'collections', 'get'),
      probeId: 'datasource.read',
      endpoints: [
        'collections:get',
        'collections/<name>/fields:list',
        'collections/<name>/fields:create',
        'mainDataSource:syncFields',
        'dataSources:readTables',
        'dataSources:loadTables',
      ],
      Component: CollectionDetailPage,
    },
    {
      path: 'preview',
      title: '数据预览',
      description: '选择业务集合，预览真实记录。',
      access: accessCheck('datasource.preview', '预览数据', 'collections', 'list'),
      probeId: 'datasource.read',
      endpoints: ['collections:list'],
      Component: PreviewPage,
    },
    {
      path: 'preview/:collectionName',
      title: '记录与操作',
      description: '记录列表、筛选排序分页、字段显示、详情、按字段类型的增改删与聚合查询。',
      access: accessCheck('datasource.records', '查看集合记录', 'collections', 'get'),
      probeId: 'datasource.read',
      endpoints: [
        '<collection>:list',
        '<collection>:get',
        '<collection>:create',
        '<collection>:update',
        '<collection>:destroy',
        '<collection>:query',
      ],
      Component: CollectionRecordsPage,
    },
    {
      path: 'access',
      title: '访问配置入口',
      description: '从数据源查看角色授权规模，并进入统一的数据授权页面。',
      access: accessCheck('datasource.access', '查看访问配置', 'roles', 'list'),
      probeId: 'access.read',
      endpoints: ['roles/<roleName>/resources:list', 'dataSourcesRolesResourcesScopes:list'],
      Component: AccessPage,
    },
  ],
});
