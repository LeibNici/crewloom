import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyHttpResponse,
  classifyNetworkError,
  extractServerCode,
  isRoleErrorCode,
  isSessionErrorCode,
  isUnknownFailure,
  signInErrorMessage,
  toErrorKind,
  UNKNOWN_PERMISSION_MESSAGE,
} from '../src/api/errors';

/**
 * 错误映射单测：确认 401 的角色失效与会话失效分开、403 的明确拒绝、
 * 三分类（拒绝 / 认证或角色失效 / 未知）以及面向用户的文案不包含状态码、
 * 接口路径或内部英文标识。
 */

describe('错误分类', () => {
  it('401 + AuthErrorCode 归类为会话失效', () => {
    const error = classifyHttpResponse({
      status: 401,
      data: { errors: [{ message: 'EMPTY_TOKEN', code: 'EMPTY_TOKEN' }] },
    });
    expect(error?.kind).toBe('unauthenticated');
    expect(error?.code).toBe('EMPTY_TOKEN');
    expect(error?.isUnauthenticated).toBe(true);
    expect(classifyFailure(error)).toBe('auth-invalid');
  });

  it('401 + ROLE_NOT_FOUND_FOR_USER / ROLE_NOT_FOUND_ERR 归类为角色失效', () => {
    for (const code of ['ROLE_NOT_FOUND_FOR_USER', 'ROLE_NOT_FOUND_ERR']) {
      const error = classifyHttpResponse({
        status: 401,
        data: { errors: [{ message: 'role error', code }] },
      });
      expect(error?.kind, code).toBe('role-invalid');
      expect(error?.isRoleInvalid).toBe(true);
      expect(error?.isUnauthenticated).toBe(false);
      expect(classifyFailure(error)).toBe('auth-invalid');
    }
    expect(isRoleErrorCode('ROLE_NOT_FOUND_ERR')).toBe(true);
    expect(isRoleErrorCode('EXPIRED_TOKEN')).toBe(false);
  });

  it('USER_HAS_NO_ROLES_ERR 按原生 AuthErrorCode 归为会话失效', () => {
    const error = classifyHttpResponse({
      status: 401,
      data: { errors: [{ code: 'USER_HAS_NO_ROLES_ERR' }] },
    });
    expect(error?.kind).toBe('unauthenticated');
  });

  it('403 归类为无权限，并与 401 区分', () => {
    const error = classifyHttpResponse({
      status: 403,
      data: { errors: [{ message: 'No permissions' }] },
    });
    expect(error?.kind).toBe('forbidden');
    expect(error?.isUnauthenticated).toBe(false);
    expect(classifyFailure(error)).toBe('denied');
  });

  it('404 / 409 / 400 / 500 有各自的分类', () => {
    expect(classifyHttpResponse({ status: 404, data: {} })?.kind).toBe('not-found');
    expect(classifyHttpResponse({ status: 409, data: {} })?.kind).toBe('conflict');
    expect(classifyHttpResponse({ status: 400, data: {} })?.kind).toBe('invalid-input');
    expect(classifyHttpResponse({ status: 422, data: {} })?.kind).toBe('invalid-input');
    expect(classifyHttpResponse({ status: 500, data: {} })?.kind).toBe('backend-unavailable');
    expect(classifyHttpResponse({ status: 503, data: {} })?.kind).toBe('backend-unavailable');
  });

  it('成功响应不产生错误', () => {
    expect(classifyHttpResponse({ status: 200, data: { data: [] } })).toBeUndefined();
  });

  it('三分类：5xx 与网络都属于"无法确认"，不当作拒绝', () => {
    expect(classifyFailure(classifyHttpResponse({ status: 500, data: {} }))).toBe('unknown');
    expect(classifyFailure(classifyNetworkError('ECONNREFUSED'))).toBe('unknown');
    expect(classifyFailure(new Error('boom'))).toBe('unknown');
    expect(isUnknownFailure(classifyHttpResponse({ status: 503, data: {} }))).toBe(true);
    expect(isUnknownFailure(classifyHttpResponse({ status: 403, data: {} }))).toBe(false);
  });

  it('用户文案不含状态码、接口路径或内部英文标识', () => {
    const samples = [
      classifyHttpResponse({ status: 401, data: { errors: [{ code: 'EXPIRED_TOKEN' }] } }),
      classifyHttpResponse({
        status: 401,
        data: { errors: [{ code: 'ROLE_NOT_FOUND_FOR_USER' }] },
      }),
      classifyHttpResponse({ status: 403, data: { errors: [{ message: 'No permissions' }] } }),
      classifyHttpResponse({ status: 500, data: {} }),
      classifyNetworkError('ECONNREFUSED 172.16.88.250:13080'),
    ];
    for (const error of samples) {
      expect(error).toBeDefined();
      const message = error!.userMessage;
      expect(message).not.toMatch(/HTTP|401|403|500|ECONNREFUSED|172\.16|\/api\/|EMPTY_TOKEN|ROLE_NOT_FOUND/);
      expect(message).toMatch(/[\u4e00-\u9fa5]/);
    }
    expect(UNKNOWN_PERMISSION_MESSAGE).not.toMatch(/HTTP|401|403|500|\/api\//);
  });
});

describe('会话与角色错误码', () => {
  it('识别核心 auth 错误码', () => {
    for (const code of [
      'EMPTY_TOKEN',
      'EXPIRED_TOKEN',
      'INVALID_TOKEN',
      'TOKEN_RENEW_FAILED',
      'BLOCKED_TOKEN',
      'EXPIRED_SESSION',
      'NOT_EXIST_USER',
      'SKIP_TOKEN_RENEW',
      'USER_HAS_NO_ROLES_ERR',
      'TOKEN_INVALID',
      'USER_LOCKED',
    ]) {
      expect(isSessionErrorCode(code), code).toBe(true);
    }
    expect(isSessionErrorCode('SOMETHING_ELSE')).toBe(false);
    expect(isSessionErrorCode(undefined)).toBe(false);
  });

  it('从错误响应体提取 code（errors[] 与 error 两种层级）', () => {
    expect(extractServerCode({ errors: [{ code: 'ROLE_NOT_FOUND_FOR_USER' }] })).toBe(
      'ROLE_NOT_FOUND_FOR_USER',
    );
    expect(extractServerCode({ error: { code: 'EXPIRED_TOKEN' } })).toBe('EXPIRED_TOKEN');
    expect(extractServerCode({ errors: [] })).toBeUndefined();
    expect(extractServerCode(null)).toBeUndefined();
  });
});

describe('登录失败文案', () => {
  it('账号不存在与密码错误使用同一提示，不做账号枚举', () => {
    const wrongPassword = classifyHttpResponse({
      status: 401,
      data: { errors: [{ message: 'Invalid password', code: 'INVALID_TOKEN' }] },
    });
    const noSuchUser = classifyHttpResponse({
      status: 401,
      data: { errors: [{ message: 'User not found', code: 'NOT_EXIST_USER' }] },
    });
    expect(signInErrorMessage(wrongPassword)).toBe(signInErrorMessage(noSuchUser));
    expect(signInErrorMessage(wrongPassword)).toContain('邮箱、用户名或密码不正确');
  });

  it('来源不被允许时给出可操作提示', () => {
    const error = classifyHttpResponse({
      status: 403,
      data: { errors: [{ message: 'Invalid sign-in origin' }] },
    });
    expect(signInErrorMessage(error)).toContain('来源');
    expect(signInErrorMessage(error)).not.toMatch(/Origin|403/);
  });

  it('未知错误回退到通用中文提示', () => {
    expect(toErrorKind(new Error('boom'))).toBe('unexpected');
    expect(signInErrorMessage(new Error('boom'))).toContain('登录未能完成');
  });
});
