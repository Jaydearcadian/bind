export interface MarketBenchmarkSnippet {
  title: string;
  url: string;
  excerpt: string;
}

export interface MarketBenchmarkResult {
  integrationMode: "LIVE_WEB_BENCHMARK" | "OFFLINE_DETERMINISTIC_FALLBACK";
  provider: "parallel" | "tavily" | "deterministic-fallback";
  skuQuery: string;
  fetchedAt: string;
  benchmarks: MarketBenchmarkSnippet[];
}

export interface MarketBenchmarkAdapter {
  fetchBenchmark(skuName: string, businessCategory: string): Promise<MarketBenchmarkResult>;
}

export class HybridMarketBenchmarkAdapter implements MarketBenchmarkAdapter {
  /**
   * `allowExternal: false` skips both keyed search providers and returns the deterministic reference (docs/decisions/0057:
   * a demo workspace never calls an outside service). Default true.
   */
  async fetchBenchmark(
    skuName: string,
    businessCategory: string,
    options: { allowExternal?: boolean } = {}
  ): Promise<MarketBenchmarkResult> {
    const query = `current wholesale bulk price ${skuName} for ${businessCategory}`;
    const external = options.allowExternal !== false;

    // 1. Prefer Parallel Search API if PARALLEL_API_KEY is configured
    if (external && process.env.PARALLEL_API_KEY) {
      try {
        const response = await fetch("https://api.parallel.ai/v1beta/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.PARALLEL_API_KEY,
          },
          body: JSON.stringify({
            objective: `Find current wholesale unit pricing and bulk supplier benchmarks for ${skuName}`,
            search_queries: [query],
            max_results: 3,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            results?: Array<{ title?: string; url?: string; excerpts?: string[] }>;
          };
          return {
            integrationMode: "LIVE_WEB_BENCHMARK",
            provider: "parallel",
            skuQuery: query,
            fetchedAt: new Date().toISOString(),
            benchmarks: (data.results ?? []).slice(0, 3).map((r) => ({
              title: r.title ?? "Parallel Wholesale Benchmark",
              url: r.url ?? "https://parallel.ai",
              excerpt: (r.excerpts ?? []).join(" ").slice(0, 280),
            })),
          };
        }
      } catch {
        // Fall through to Tavily or deterministic fallback
      }
    }

    // 2. Fallback to Tavily Search API if TAVILY_API_KEY is configured
    if (external && process.env.TAVILY_API_KEY) {
      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            search_depth: "basic",
            max_results: 3,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            results?: Array<{ title?: string; url?: string; content?: string }>;
          };
          return {
            integrationMode: "LIVE_WEB_BENCHMARK",
            provider: "tavily",
            skuQuery: query,
            fetchedAt: new Date().toISOString(),
            benchmarks: (data.results ?? []).slice(0, 3).map((r) => ({
              title: r.title ?? "Tavily Wholesale Benchmark",
              url: r.url ?? "https://tavily.com",
              excerpt: (r.content ?? "").slice(0, 280),
            })),
          };
        }
      } catch {
        // Fall through to deterministic fallback
      }
    }

    // 3. Deterministic offline fallback (keeps verify-local.sh 100% green without network keys)
    return {
      integrationMode: "OFFLINE_DETERMINISTIC_FALLBACK",
      provider: "deterministic-fallback",
      skuQuery: query,
      fetchedAt: new Date().toISOString(),
      benchmarks: [
        {
          title: `Reference Wholesale Index: ${skuName}`,
          url: "https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29",
          excerpt: `Offline reference benchmark used because live search API keys are not active in this test environment.`,
        },
      ],
    };
  }
}
