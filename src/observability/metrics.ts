/**
 * A small in-process metrics registry rendered as Prometheus text exposition 0.0.4 (docs/decisions/0032). No dependency.
 *
 * Counters, gauges and histograms with fixed label names. A label value is escaped (backslash, quote, newline). Numbers
 * are written without an exponent, so every sample line is plain decimal. Metrics are per process: two instances report
 * their own values.
 *
 * Labels are aggregate only: a method, a route pattern, a status class, a workflow state, an order status, a worker step.
 * No workspace id, token, customer or supplier text is ever a label.
 */

export type Labels = Record<string, string>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Escapes a label value: backslash, double quote and newline. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Escapes HELP text: backslash and newline. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** A sample value as plain decimal text. Non-integers are written in fixed notation, never with an exponent. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const pairs = names.map((name, i) => `${name}="${escapeLabelValue(values[i])}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

function valuesFor(names: readonly string[], labels: Labels): string[] {
  return names.map((name) => {
    if (!(name in labels)) throw new Error(`Missing label '${name}'`);
    return String(labels[name]);
  });
}

function keyOf(values: readonly string[]): string {
  return JSON.stringify(values);
}

interface Family {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  render(): string[];
}

class BaseFamily {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[]
  ) {
    if (!METRIC_NAME.test(name)) throw new Error(`Invalid metric name '${name}'`);
    for (const label of labelNames) {
      if (!LABEL_NAME.test(label)) throw new Error(`Invalid label name '${label}'`);
    }
  }

  protected header(type: string): string[] {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${type}`];
  }
}

/** A monotonically increasing count. */
export class Counter extends BaseFamily implements Family {
  readonly type = "counter" as const;
  private readonly series = new Map<string, { values: string[]; value: number }>();

  inc(labels: Labels = {}, by = 1): void {
    if (!Number.isFinite(by) || by < 0) throw new Error("A counter only increases by a finite non-negative amount");
    const values = valuesFor(this.labelNames, labels);
    const key = keyOf(values);
    const entry = this.series.get(key) ?? { values, value: 0 };
    entry.value += by;
    this.series.set(key, entry);
  }

  get(labels: Labels = {}): number {
    return this.series.get(keyOf(valuesFor(this.labelNames, labels)))?.value ?? 0;
  }

  render(): string[] {
    const out = this.header("counter");
    for (const entry of this.series.values()) {
      out.push(`${this.name}${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.value)}`);
    }
    return out;
  }
}

/** A value that can go up and down. `replaceAll` sets a whole snapshot, so a label that disappeared is removed. */
export class Gauge extends BaseFamily implements Family {
  readonly type = "gauge" as const;
  private readonly series = new Map<string, { values: string[]; value: number }>();

  set(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) throw new Error("A gauge value must be a finite number");
    const values = valuesFor(this.labelNames, labels);
    this.series.set(keyOf(values), { values, value });
  }

  replaceAll(entries: Array<{ labels: Labels; value: number }>): void {
    this.series.clear();
    for (const entry of entries) this.set(entry.labels, entry.value);
  }

  get(labels: Labels = {}): number | undefined {
    return this.series.get(keyOf(valuesFor(this.labelNames, labels)))?.value;
  }

  render(): string[] {
    const out = this.header("gauge");
    for (const entry of this.series.values()) {
      out.push(`${this.name}${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.value)}`);
    }
    return out;
  }
}

interface HistogramSeries {
  values: string[];
  counts: number[];
  sum: number;
  count: number;
}

/** Cumulative buckets, a sum and a count, rendered as the `_bucket`, `_sum` and `_count` samples. */
export class Histogram extends BaseFamily implements Family {
  readonly type = "histogram" as const;
  private readonly series = new Map<string, HistogramSeries>();
  readonly buckets: readonly number[];

  constructor(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []) {
    super(name, help, labelNames);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.some((b) => !Number.isFinite(b))) throw new Error("Histogram buckets must be finite");
    this.buckets = sorted;
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const values = valuesFor(this.labelNames, labels);
    const key = keyOf(values);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { values, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    this.buckets.forEach((bound, i) => {
      if (value <= bound) entry!.counts[i] += 1;
    });
    entry.sum += value;
    entry.count += 1;
  }

  /** The number of observations for a label set (0 when none). */
  countOf(labels: Labels = {}): number {
    return this.series.get(keyOf(valuesFor(this.labelNames, labels)))?.count ?? 0;
  }

  render(): string[] {
    const out = this.header("histogram");
    for (const entry of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        out.push(
          `${this.name}_bucket${renderLabels(this.labelNames, entry.values, ["le", formatValue(bound)])} ${formatValue(entry.counts[i])}`
        );
      });
      out.push(`${this.name}_bucket${renderLabels(this.labelNames, entry.values, ["le", "+Inf"])} ${formatValue(entry.count)}`);
      out.push(`${this.name}_sum${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.sum)}`);
      out.push(`${this.name}_count${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.count)}`);
    }
    return out;
  }
}

export class Registry {
  private readonly families = new Map<string, Family>();

  private add<T extends Family>(family: T): T {
    if (this.families.has(family.name)) throw new Error(`Metric '${family.name}' is already registered`);
    this.families.set(family.name, family);
    return family;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }

  histogram(name: string, help: string, buckets: readonly number[], labelNames: readonly string[] = []): Histogram {
    return this.add(new Histogram(name, help, buckets, labelNames));
  }

  /** The whole exposition text, families in registration order. */
  render(): string {
    const lines: string[] = [];
    for (const family of this.families.values()) lines.push(...family.render());
    return `${lines.join("\n")}\n`;
  }
}

export const registry = new Registry();

/** Upper bounds in seconds for request and tick durations (docs/decisions/0032). */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const TICK_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export const httpRequests = registry.counter(
  "bind_http_requests_total",
  "HTTP requests answered, by method, route pattern and status class.",
  ["method", "route", "status_class"]
);
export const httpDuration = registry.histogram(
  "bind_http_request_duration_seconds",
  "HTTP request duration in seconds, from arrival to the finish event.",
  DURATION_BUCKETS
);
export const workflowsByState = registry.gauge("bind_workflows", "Workflows by state.", ["state"]);
export const approvalsPending = registry.gauge("bind_approvals_pending", "Approvals waiting for a decision.");
export const approvalsOldestPendingAge = registry.gauge(
  "bind_approvals_oldest_pending_age_seconds",
  "Age in seconds of the oldest pending approval, 0 when none is pending."
);
export const effectsUnresolved = registry.gauge(
  "bind_effects_unresolved",
  "Effects not completed, by status (started or failed).",
  ["status"]
);
export const effectsRetried = registry.gauge(
  "bind_effects_retried",
  "Effects attempted more than once."
);
export const ordersByStatus = registry.gauge("bind_orders", "Orders by status.", ["status"]);
export const workerLastTick = registry.gauge(
  "bind_worker_last_tick_timestamp_seconds",
  "Unix time in seconds when the last worker tick finished, 0 before the first tick."
);
export const workerTickDuration = registry.histogram(
  "bind_worker_tick_duration_seconds",
  "Worker tick duration in seconds.",
  TICK_BUCKETS
);
export const workerStepErrors = registry.counter(
  "bind_worker_step_errors_total",
  "Worker step errors, by step.",
  ["step"]
);
/** Requests answered 429 by a rate limit, by scope (docs/decisions/0033). The label is the scope name only. */
export const rateLimited = registry.counter(
  "bind_rate_limited_total",
  "Requests answered 429 by a rate limit, by scope.",
  ["scope"]
);
/** Open event streams in this process (docs/decisions/0035). No tenant label: the count is aggregate. */
export const sseStreams = registry.gauge("bind_sse_streams", "Open event streams in this process.");
/** Events written to event streams (docs/decisions/0035). Heartbeats are not events and are not counted. */
export const sseEventsSent = registry.counter("bind_sse_events_sent_total", "Events written to event streams.");
/** Streams refused by a cap, by reason: token, workspace or global (docs/decisions/0035). */
export const sseStreamsRejected = registry.counter(
  "bind_sse_streams_rejected_total",
  "Event streams refused by a cap, by reason.",
  ["reason"]
);
// A family with no sample renders no sample line. These start at zero, so a scrape always shows them.
sseStreams.set({}, 0);
sseEventsSent.inc({}, 0);
for (const reason of ["token", "workspace", "global"]) sseStreamsRejected.inc({ reason }, 0);
export const workerLag = registry.gauge(
  "bind_worker_lag_seconds",
  "Seconds since the last worker tick finished, -1 before the first tick."
);

/** The Unix time in seconds of the last tick, or null before the first tick. Set by the worker. */
let lastTickSeconds: number | null = null;

/** Records a finished tick: its duration, the time it finished, and the errors each step reported. */
export function recordWorkerTick(durationSeconds: number, errorSteps: readonly string[], finishedAtMs: number = Date.now()): void {
  workerTickDuration.observe({}, durationSeconds);
  for (const step of errorSteps) workerStepErrors.inc({ step });
  lastTickSeconds = finishedAtMs / 1000;
  workerLastTick.set({}, lastTickSeconds);
}

/** Seconds since the last tick, or -1 before the first tick. Read at scrape time, so it grows between ticks. */
export function workerLagSeconds(nowMs: number = Date.now()): number {
  if (lastTickSeconds === null) return -1;
  return Math.max(0, nowMs / 1000 - lastTickSeconds);
}
