/** One scrape of a `/metrics` endpoint: every sample, with its labels. */
export type Scrape = {
  /** The value of one series, by its exact text (`name` or `name{a="1",b="2"}`). */
  readonly get: (series: string) => number | undefined;
  /** The sum of every sample of `name` whose labels include all of `labels`. */
  readonly sum: (name: string, labels?: Readonly<Record<string, string>>) => number;
};

type Sample = {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
};

const SAMPLE_LINE = /^([a-z_:]+)(?:\{([^}]*)\})? (\S+)$/;
const LABEL = /([a-z_]+)="((?:[^"\\]|\\.)*)"/g;

/** Scrapes `GET <baseUrl>/metrics` (the health server, docs/09) and parses the text format. */
export async function scrape(baseUrl: string): Promise<Scrape> {
  const res = await fetch(`${baseUrl}/metrics`);
  if (!res.ok) throw new Error(`/metrics answered ${res.status}`);
  const bySeries = new Map<string, number>();
  const samples: Sample[] = [];
  for (const line of (await res.text()).split('\n')) {
    const match = SAMPLE_LINE.exec(line);
    if (match === null) continue;
    const [, name = '', labelText, raw = ''] = match;
    const value = Number(raw);
    const labels: Record<string, string> = {};
    for (const [, key = '', labelValue = ''] of (labelText ?? '').matchAll(LABEL)) {
      labels[key] = labelValue;
    }
    bySeries.set(labelText === undefined ? name : `${name}{${labelText}}`, value);
    samples.push({ name, labels, value });
  }
  return {
    get: (series) => bySeries.get(series),
    sum: (name, labels = {}) =>
      samples
        .filter(
          (sample) =>
            sample.name === name &&
            Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
        )
        .reduce((total, sample) => total + sample.value, 0),
  };
}
