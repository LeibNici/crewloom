import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  fetchAttachmentCapability,
  formatFileSize,
  resolveFileUrl,
  uploadAttachment,
  type AttachmentRecord,
} from '../api/attachments';
import { toUserMessage } from '../api/errors';
import styles from './AttachmentControl.module.css';

/**
 * 附件控件（PUB-04，公共负责人维护，供各模块复用）。
 *
 * 提供的都是已核对的真实能力：
 *  - 展示：用记录上的永久访问地址（`url`/`preview`）预览或提供下载链接；
 *  - 上传/替换：`POST attachments:upload`（multipart），只有真实用户点击才会发生；
 *  - 移除：只把值置空并回调，**不**替调用方删后端记录（删除是各模块自己的动作）；
 *  - 能力未开通：后端没有可用存储时明确说明原因，而不是让上传按钮失败后弹"服务不可用"。
 *
 * 不做的：不做附件列表（后端 `attachments:list` 是设计上的 404），不猜测字段名。
 */

export interface AttachmentValue {
  id?: number | string | null;
  url?: string | null;
  preview?: string | null;
  title?: string | null;
  filename?: string | null;
  size?: number | null;
  mimetype?: string | null;
  [key: string]: unknown;
}

interface AttachmentControlProps {
  value: AttachmentValue | null;
  /** 是否允许用户修改；只读时只显示当前附件。 */
  editable?: boolean;
  /** 关联字段（例如 `users.avatar`），用于确定该字段配置的存储。 */
  attachmentField?: string;
  /** 附件变化回调；由调用方决定何时保存到记录。 */
  onChange?: (next: AttachmentValue | null) => void;
  /** `avatar` 显示为头像预览，`file` 显示为文件名 + 下载链接。 */
  variant?: 'avatar' | 'file';
  label?: string;
}

export function AttachmentControl({
  value,
  editable = false,
  attachmentField,
  onChange,
  variant = 'file',
  label = '附件',
}: AttachmentControlProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const capability = useQuery({
    queryKey: ['attachments', 'capability'],
    queryFn: fetchAttachmentCapability,
    enabled: editable,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const url = resolveFileUrl(value);
  const capabilityMessage = capability.data?.message ?? null;

  async function handleFile(file: File | null) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const record = await uploadAttachment(file, { attachmentField });
      onChange?.(record as AttachmentRecord);
    } catch (uploadError) {
      setError(toUserMessage(uploadError));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const preview =
    variant === 'avatar' ? (
      url && !imageFailed ? (
        <img
          className={styles.avatar}
          src={url}
          alt=""
          onError={() => setImageFailed(true)}
          loading="lazy"
        />
      ) : (
        <span className={styles.avatarFallback} aria-hidden="true">
          {(value?.title ?? value?.filename ?? '附').slice(0, 1)}
        </span>
      )
    ) : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.row}>
        {preview}
        {variant === 'file' ? (
          url ? (
            <a className={styles.link} href={url} target="_blank" rel="noreferrer">
              {value?.title ?? value?.filename ?? '查看附件'}
            </a>
          ) : (
            <span className={styles.placeholder}>暂无可预览的附件</span>
          )
        ) : null}
        {variant === 'file' && value?.size ? (
          <span className={styles.meta}>{formatFileSize(value.size)}</span>
        ) : null}

        {editable ? (
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              disabled={busy || capability.isLoading || capability.data?.canUpload !== true}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? '正在上传…' : value ? '替换' : '上传'}
            </button>
            {value ? (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => {
                  setImageFailed(false);
                  setError(null);
                  onChange?.(null);
                }}
              >
                移除
              </button>
            ) : null}
          </span>
        ) : null}
      </div>

      {editable ? (
        <input
          ref={inputRef}
          className={styles.input}
          type="file"
          aria-label={`选择${label}`}
          onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
        />
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {!error && capability.isError ? (
        <p className={styles.hint}>暂时无法确认附件能力，请稍后重试。</p>
      ) : null}
      {!error && capabilityMessage && capability.data?.canUpload !== true ? (
        <p className={styles.hint}>{capabilityMessage}</p>
      ) : null}
    </div>
  );
}
