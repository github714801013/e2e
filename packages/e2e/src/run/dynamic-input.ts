import { ConfigurationError } from '../internal/errors.ts';

/** 一个作业完成收集并进入当前 Run 后的受理凭证。 */
export interface DynamicSubmission {
  readonly accepted: true;
  /** 本次提交新增的普通测试结果 ID。 */
  readonly resultIds: readonly string[];
  /** 本次提交新增的共享认证 Setup 结果 ID；作业需要等待它们完成。 */
  readonly setupIds: readonly string[];
}

/** 同一 Run 的一次提交，作业编号仅用于调用方关联。 */
export interface DynamicSubmitOptions {
  readonly jobId: string;
  readonly files: readonly string[];
}

export interface PendingSubmission extends DynamicSubmitOptions {
  accept(receipt: DynamicSubmission): void;
  reject(cause: unknown): void;
}

/** 串行消费提交，封口保留此前已接收的请求，结束时拒绝未受理请求。 */
export class DynamicRunInput {
  private readonly queue: PendingSubmission[] = [];
  private readonly pending = new Set<PendingSubmission>();
  private readonly jobs = new Set<string>();
  private wake: (() => void) | undefined;
  private sealed = false;
  private stopped = false;

  constructor(readonly runId: string) {}

  /** 执行已结束，正在收集的提交不应再进入调度。 */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** 同步确定接收边界，收集和入队成功后才完成受理。 */
  submit(options: DynamicSubmitOptions): Promise<DynamicSubmission> {
    if (this.sealed || this.stopped) return Promise.reject(new ConfigurationError('INVALID_ARGUMENT', 'the dynamic run is sealed and takes no more submissions'));
    if (typeof options.jobId !== 'string' || options.jobId.trim() === '' || !Array.isArray(options.files) || options.files.length === 0 || options.files.some((file) => typeof file !== 'string' || file.trim() === '')) {
      return Promise.reject(new ConfigurationError('INVALID_ARGUMENT', 'a submission needs a job id and a non-empty file list'));
    }
    if (this.jobs.has(options.jobId)) return Promise.reject(new ConfigurationError('INVALID_ARGUMENT', 'the job id was already submitted'));
    this.jobs.add(options.jobId);
    return new Promise((resolve, reject) => {
      const request: PendingSubmission = {
        jobId: options.jobId,
        files: [...options.files],
        accept: (receipt) => { this.pending.delete(request); resolve(receipt); },
        reject: (cause) => { this.pending.delete(request); reject(cause); },
      };
      this.pending.add(request);
      this.queue.push(request);
      this.notify();
    });
  }

  /** 等待下一次提交；输入封口且已排空时返回。 */
  async take(): Promise<PendingSubmission | undefined> {
    while (!this.stopped) {
      const next = this.queue.shift();
      if (next !== undefined) return next;
      if (this.sealed) return undefined;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    return undefined;
  }

  /** 不可逆地停止接收，已排队的提交继续收集。 */
  seal(): void {
    this.sealed = true;
    this.notify();
  }

  /** 执行已经结束，唤醒等待者并拒绝所有尚未受理的提交。 */
  stop(): void {
    this.stopped = true;
    this.sealed = true;
    for (const request of this.pending) request.reject(new ConfigurationError('INVALID_ARGUMENT', 'the dynamic run ended before the submission was accepted'));
    this.queue.length = 0;
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
