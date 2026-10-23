import { CollectionError, ConfigurationError } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { Collection, CollectedTest } from '../collect/collect.ts';
import type { Selection, TestTargetPair } from '../collect/select.ts';
import type { DynamicRunInput, PendingSubmission } from './dynamic-input.ts';
import { MAX_IPC_RESULT_IDS } from './dynamic-ipc.ts';
import { buildWorkPlans, type TargetWorkPlan } from './units.ts';

/** 仅将本次明确提交的测试和它依赖的 Setup 纳入动态报告。 */
export class DynamicPlan {
  private readonly setups = new Map<string, readonly string[]>();
  private readonly acceptedSetups = new Set<string>();
  private readonly occurrences = new Map<string, number>();
  private readonly pairs: TestTargetPair[] = [];
  private started = false;
  private sequence = 0;

  constructor(tests: readonly CollectedTest[]) {
    for (const test of tests) if (test.kind === 'setup') this.setups.set(test.id, test.sessions);
  }

  /** 保留 Setup 身份，重复普通测试使用原生 repeat 维度获得独立结果和证据。 */
  append(selection: Selection, submitted: ReadonlySet<string>): Selection {
    // The accepted message carries at most this many ids; checking before any
    // state changes keeps a refused submission out of the scheduler entirely.
    const ordinary = selection.pairs.filter(
      (pair) =>
        pair.test.kind === 'test' && (pair.disposition === 'run' || submitted.has(pair.test.file)),
    ).length;
    if (ordinary > MAX_IPC_RESULT_IDS) {
      throw new ConfigurationError(
        'INVALID_ARGUMENT',
        `the submission selected ${ordinary} tests; a job runs at most ${MAX_IPC_RESULT_IDS}`,
      );
    }
    for (const pair of selection.pairs) {
      if (pair.test.kind !== 'setup' || pair.disposition !== 'run') continue;
      const sessions = this.setups.get(pair.test.id);
      if (sessions === undefined || JSON.stringify(sessions) !== JSON.stringify(pair.test.sessions)) {
        throw new CollectionError('a dynamic job cannot introduce a new authentication setup; start a new run');
      }
      if (this.started && !this.acceptedSetups.has(resultId(pair.test.id, pair.target.name, pair.agent))) {
        throw new CollectionError('a dynamic job cannot introduce a new authentication setup; start a new run');
      }
    }
    const pairs = selection.pairs.flatMap((pair) => {
      const key = resultId(pair.test.id, pair.target.name, pair.agent);
      if (pair.test.kind === 'setup') {
        if (pair.disposition !== 'run' || this.acceptedSetups.has(key)) return [];
        this.acceptedSetups.add(key);
        return [pair];
      }
      // 串行闭包会把同组但未显式提交的文件成员改为 run，动态计划必须保留它们。
      // 提交文件中的 skip/filtered 测试也进入报告，与静态运行的原生结果一致。
      if (pair.disposition !== 'run' && !submitted.has(pair.test.file)) return [];
      const repeat = this.occurrences.get(key) ?? 0;
      this.occurrences.set(key, repeat + 1);
      return [{ ...pair, repeat }];
    });
    this.pairs.push(...pairs);
    this.started = true;
    return { pairs, perTarget: selection.perTarget.map(({ target }) => ({ target, pairs: pairs.filter((pair) => pair.target.name === target.name) })) };
  }

  /** 新提交的执行单元拥有唯一编号，已派发单元保持原样。 */
  plans(selection: Selection, collection: Collection, root: string): TargetWorkPlan[] {
    this.sequence += 1;
    const suffix = String(this.sequence);
    return buildWorkPlans(selection, collection, root).map((plan) => ({
      ...plan,
      setupUnits: plan.setupUnits.map((unit) => ({ ...unit, id: `${unit.id}::${suffix}` })),
      fileUnits: plan.fileUnits.map((unit) => ({ ...unit, id: `${unit.id}::${suffix}` })),
    }));
  }

  /** 提交凭证只含当前作业的普通测试；共享认证以 Setup ID 单独报告，供调用方判断是否等待。 */
  accept(request: PendingSubmission, selection: Selection): void {
    request.accept({
      accepted: true,
      resultIds: selection.pairs.filter((pair) => pair.test.kind === 'test').map((pair) => resultId(pair.test.id, pair.target.name, pair.agent, pair.repeat)),
      setupIds: selection.pairs.filter((pair) => pair.test.kind === 'setup' && pair.disposition === 'run').map((pair) => resultId(pair.test.id, pair.target.name, pair.agent)),
    });
  }

  /** 供进度事件使用的当前累计计划。 */
  selection(template: Selection): Selection {
    return { pairs: [...this.pairs], perTarget: template.perTarget.map(({ target }) => ({ target, pairs: this.pairs.filter((pair) => pair.target.name === target.name) })) };
  }
}

/** 串行收集并追加，单个提交失败不会终止其他已受理作业。 */
export async function* dynamicAdditions(
  input: DynamicRunInput,
  collect: (request: PendingSubmission) => Promise<readonly TargetWorkPlan[]>,
): AsyncGenerator<readonly TargetWorkPlan[]> {
  for (;;) {
    const request = await input.take();
    if (request === undefined) return;
    try {
      yield await collect(request);
    } catch (cause) {
      request.reject(cause);
    }
  }
}
