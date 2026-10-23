import { describe, it, expect } from "vitest";
import { Registry, escapeHelp, escapeLabelValue, formatValue, recordWorkerTick, workerLagSeconds } from "../../src/observability/metrics.js";

/** The in-process registry and its exposition text (docs/decisions/0032). Pure: no database, no HTTP. */

describe("metrics registry", () => {
  it("escapes label values and HELP text", () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeHelp("line one\nline \\ two")).toBe("line one\\nline \\\\ two");
  });

  it("writes plain decimal numbers, never an exponent", () => {
    expect(formatValue(3)).toBe("3");
    expect(formatValue(-1)).toBe("-1");
    expect(formatValue(0.0000001)).toBe("0.0000001");
    expect(formatValue(0.005)).toBe("0.005");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(1781234567.123)).toMatch(/^1781234567\.\d+$/);
    for (const value of [0.0000001, 1e-9, 123.456, 1e15 + 0.5]) {
      expect(formatValue(value)).not.toMatch(/e/i);
    }
  });

  it("renders HELP and TYPE before the samples of each family, in registration order", () => {
    const reg = new Registry();
    const c = reg.counter("t_requests_total", "Requests.", ["method"]);
    const g = reg.gauge("t_depth", "Depth.");
    const h = reg.histogram("t_seconds", "Seconds.", [0.1, 1]);
    c.inc({ method: "GET" });
    c.inc({ method: "GET" }, 2);
    g.set({}, 4);
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 5);

    const text = reg.render();
    const lines = text.trim().split("\n");
    expect(lines).toEqual([
      "# HELP t_requests_total Requests.",
      "# TYPE t_requests_total counter",
      't_requests_total{method="GET"} 3',
      "# HELP t_depth Depth.",
      "# TYPE t_depth gauge",
      "t_depth 4",
      "# HELP t_seconds Seconds.",
      "# TYPE t_seconds histogram",
      't_seconds_bucket{le="0.1"} 1',
      't_seconds_bucket{le="1"} 2',
      't_seconds_bucket{le="+Inf"} 3',
      "t_seconds_sum 5.55",
      "t_seconds_count 3",
    ]);
  });

  it("refuses a duplicate name, an invalid name, a missing label and a negative counter step", () => {
    const reg = new Registry();
    reg.counter("t_once_total", "Once.", ["step"]);
    expect(() => reg.counter("t_once_total", "Again.")).toThrow(/already registered/);
    expect(() => reg.counter("bad name", "Bad.")).toThrow(/Invalid metric name/);
    expect(() => reg.counter("t_labels_total", "Labels.", ["bad-label"])).toThrow(/Invalid label name/);
    const counter = reg.counter("t_missing_total", "Missing.", ["step"]);
    expect(() => counter.inc({})).toThrow(/Missing label/);
    expect(() => counter.inc({ step: "a" }, -1)).toThrow();
  });

  it("gauges replace a whole family, so a vanished label is removed", () => {
    const reg = new Registry();
    const g = reg.gauge("t_states", "States.", ["state"]);
    g.replaceAll([{ labels: { state: "draft" }, value: 2 }, { labels: { state: "failed" }, value: 1 }]);
    g.replaceAll([{ labels: { state: "draft" }, value: 5 }]);
    expect(reg.render()).not.toContain('state="failed"');
    expect(reg.render()).toContain('t_states{state="draft"} 5');
  });

  it("records a worker tick and reports lag from the last tick", () => {
    recordWorkerTick(0.02, ["recovery"], Date.now() - 5000);
    const lag = workerLagSeconds();
    expect(lag).toBeGreaterThanOrEqual(4.5);
    expect(lag).toBeLessThan(60);
  });
});
