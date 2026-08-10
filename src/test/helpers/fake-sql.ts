/**
 * A stand-in for the postgres.js tagged-template client.
 *
 * The billing code talks to Postgres exclusively through sql`…` template
 * literals, so a test double has to be callable as a tag. This one records
 * every query, lets a test register canned responses by matching the SQL text,
 * and models `sql.begin` well enough to prove that a failed transaction leaves
 * no partial state — which is the specific claim BILL-001 asks us to verify.
 *
 * Matching is done against a NORMALISED form of the query: parameter slots
 * become `?`, and runs of whitespace collapse to a single space. That keeps the
 * patterns in tests readable (/INSERT INTO billing_transactions/) and stops
 * them breaking every time someone reindents a query.
 */

export type Row = Record<string, any>;
export type QueryResult = Row[];

export type Responder =
  | QueryResult
  | ((params: any[], text: string) => QueryResult | Promise<QueryResult>);

export interface RecordedQuery {
  /** Normalised SQL: parameters replaced by `?`, whitespace collapsed. */
  text: string;
  /** The interpolated values, in order. */
  params: any[];
  /** True when the query ran inside a `begin` block that later rolled back. */
  rolledBack?: boolean;
}

interface Rule {
  pattern: RegExp;
  responder?: Responder;
  error?: Error;
  /** Consume the rule after one match (used by failOnce). */
  once?: boolean;
  used?: boolean;
}

export interface FakeSql {
  (strings: TemplateStringsArray, ...values: any[]): Promise<QueryResult>;
  /** Every query the code under test ran, in order, committed or not. */
  queries: RecordedQuery[];
  /** Queries that were discarded by a rolled-back transaction. */
  rolledBack: RecordedQuery[];
  begin<T>(fn: (tx: FakeSql) => Promise<T>): Promise<T>;
  when(pattern: RegExp, responder: Responder): FakeSql;
  /** Throw for every query matching `pattern`. */
  failOn(pattern: RegExp, error?: Error): FakeSql;
  /** Throw for the FIRST query matching `pattern`, then behave normally. */
  failOnce(pattern: RegExp, error?: Error): FakeSql;
  /** Make the commit of the next `begin` block fail, after its body has run. */
  failCommit(error?: Error): FakeSql;
  matching(pattern: RegExp): RecordedQuery[];
  countMatching(pattern: RegExp): number;
  reset(): void;
}

const normalise = (strings: TemplateStringsArray): string =>
  strings.raw.join('?').replace(/\s+/g, ' ').trim();

export function createFakeSql(): FakeSql {
  const rules: Rule[] = [];
  let commitFailure: Error | null = null;

  // Queries land here first so a rolled-back transaction can pull them back out.
  const log: RecordedQuery[] = [];
  const rolledBack: RecordedQuery[] = [];

  const run = async (
    strings: TemplateStringsArray,
    values: any[],
    sink: RecordedQuery[],
  ): Promise<QueryResult> => {
    const text = normalise(strings);
    sink.push({ text, params: values });

    for (const rule of rules) {
      if (rule.once && rule.used) continue;
      if (!rule.pattern.test(text)) continue;
      rule.used = true;
      if (rule.error) throw rule.error;
      if (typeof rule.responder === 'function') return rule.responder(values, text);
      return rule.responder ?? [];
    }
    // Unmatched queries succeed with no rows. Writes legitimately return nothing,
    // so failing here would force every test to stub every UPDATE it triggers.
    return [];
  };

  const makeTag = (sink: RecordedQuery[]): any => {
    const tag = (strings: TemplateStringsArray, ...values: any[]) => run(strings, values, sink);
    return tag;
  };

  const sql: any = makeTag(log);

  sql.queries = log;
  sql.rolledBack = rolledBack;

  sql.begin = async <T>(fn: (tx: FakeSql) => Promise<T>): Promise<T> => {
    // Buffer the transaction's queries so a failure can discard them, the way a
    // real ROLLBACK would. Tests assert against sql.queries to show that a
    // half-finished operation left nothing behind.
    const buffer: RecordedQuery[] = [];
    const tx: any = makeTag(buffer);
    tx.queries = buffer;
    tx.begin = sql.begin;
    tx.when = sql.when;
    tx.matching = sql.matching;

    try {
      const result = await fn(tx as FakeSql);
      if (commitFailure) {
        const err = commitFailure;
        commitFailure = null;
        buffer.forEach((q) => rolledBack.push({ ...q, rolledBack: true }));
        throw err;
      }
      buffer.forEach((q) => log.push(q));
      return result;
    } catch (err) {
      // Body threw (or the commit did): nothing in the block is visible.
      if (!rolledBack.includes(buffer[0] as RecordedQuery)) {
        buffer.forEach((q) => {
          if (!rolledBack.some((r) => r === q)) rolledBack.push({ ...q, rolledBack: true });
        });
      }
      throw err;
    }
  };

  sql.when = (pattern: RegExp, responder: Responder) => {
    rules.push({ pattern, responder });
    return sql;
  };
  sql.failOn = (pattern: RegExp, error?: Error) => {
    rules.push({ pattern, error: error ?? new Error(`fake-sql: forced failure on ${pattern}`) });
    return sql;
  };
  sql.failOnce = (pattern: RegExp, error?: Error) => {
    rules.push({
      pattern,
      error: error ?? new Error(`fake-sql: forced failure on ${pattern}`),
      once: true,
    });
    return sql;
  };
  sql.failCommit = (error?: Error) => {
    commitFailure = error ?? new Error('fake-sql: forced commit failure');
    return sql;
  };
  sql.matching = (pattern: RegExp) => log.filter((q) => pattern.test(q.text));
  sql.countMatching = (pattern: RegExp) => sql.matching(pattern).length;
  sql.reset = () => {
    rules.length = 0;
    log.length = 0;
    rolledBack.length = 0;
    commitFailure = null;
  };

  return sql as FakeSql;
}
