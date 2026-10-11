import type { ModuleDefinition } from '../types';
import { Link } from 'react-router';
import { PageCard, PageHeader } from '../../components/Card';
import styles from './group-a.module.css';

/**
 * 模块首页（组 A 共用）。
 *
 * 模块根路径不能只回退到公共占位页——那会把这个已实现的模块说成"功能尚未开放"。
 * 这里列出本模块真正实现的页面，并提供进入入口；带参数的页面（详情）不在这里列成死链接，
 * 而是通过列表页进入。
 */

export function ModuleHub({ module }: { module: ModuleDefinition }) {
  const pages = module.boards.filter((board) => !board.path.includes(':'));
  const detailPages = module.boards.filter((board) => board.path.includes(':'));

  return (
    <div className={styles.stack}>
      <PageHeader title={module.title} description={module.subtitle} />
      <PageCard title="本模块的页面" description="点击即可进入。">
        <div className={styles.rowList}>
          {pages.map((board) => (
            <div key={board.path} className={styles.rowCard}>
              <div className={styles.rowMain}>
                <span className={styles.rowTitle}>{board.title}</span>
                <span className={styles.rowHint}>{board.description}</span>
              </div>
              <div className={styles.rowActions}>
                <Link className={styles.button} to={`${module.path}/${board.path}`}>
                  进入
                </Link>
              </div>
            </div>
          ))}
        </div>
        {detailPages.length > 0 ? (
          <p className={styles.rowHint} style={{ marginTop: 12 }}>
            详情页（{detailPages.map((board) => board.title).join('、')}）需要从对应列表里选择具体记录后进入。
          </p>
        ) : null}
      </PageCard>
    </div>
  );
}
