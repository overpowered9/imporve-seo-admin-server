/**
 * A small in-memory Stripe, covering only the calls the billing module makes.
 *
 * It is stateful on purpose. Assertions like "after resubscribing, the
 * subscription no longer carries cancel_at_period_end" or "the customer ends up
 * with exactly one default payment method" are claims about STATE, and a
 * call-recording spy cannot express them — it can only show that some method was
 * invoked with some argument, which is a much weaker thing to prove.
 *
 * Every method also records its arguments, so tests that genuinely care about
 * the call (e.g. "was an idempotency key sent?") can still check that.
 */

export interface FakeCard {
  id: string;
  customer: string | null;
  created: number;
  card: { brand: string; last4: string; exp_month: number; exp_year: number };
  type: 'card';
}

export interface FakeCustomer {
  id: string;
  email?: string;
  metadata?: Record<string, string>;
  invoice_settings: { default_payment_method: string | null };
  deleted?: false;
}

/**
 * ── WHERE current_period_end LIVES ──────────────────────────────────────────
 * On the ITEM, and only on the item. This fake used to put it at the top level,
 * which is the pre-2025 shape real Stripe stopped sending — so every test
 * exercised a branch production never took, and five call sites reading
 * `subscription.current_period_end` silently fell through to "now + 30 days"
 * for months. Verified against a live subscription on 2025-10-29.clover:
 *
 *     sub.current_period_end   = undefined
 *     item.current_period_end  = 1790409310
 *
 * The top-level field is kept OPTIONAL so a fixture can still assert the legacy
 * fallback path, but makeSubscription no longer emits it. A test double that
 * models a provider which no longer exists is worse than no double at all.
 */
export interface FakeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  /** Pre-2025 location. Absent on real payloads; set it only to test that path. */
  current_period_end?: number;
  default_payment_method: string | null;
  items: { data: Array<{ id: string; price: { id: string }; current_period_end?: number }> };
  metadata: Record<string, string>;
  schedule?: string | null;
  latest_invoice?: any;
}

export interface FakeInvoice {
  id: string;
  customer: string;
  subscription?: string | null;
  created: number;
  currency: string;
  amount_paid: number;
  amount_due: number;
  status: string;
  billing_reason?: string;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  lines: { data: Array<any> };
}

export interface RecordedCall {
  method: string;
  args: any[];
}

export interface FakeStripeOptions {
  /** Cards to seed, keyed by customer id. */
  cards?: FakeCard[];
  customers?: FakeCustomer[];
  subscriptions?: FakeSubscription[];
  invoices?: FakeInvoice[];
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(++seq).toString().padStart(4, '0')}`;

export const makeCard = (over: Partial<FakeCard> = {}): FakeCard => ({
  id: over.id ?? nextId('pm'),
  customer: over.customer ?? 'cus_test',
  created: over.created ?? Math.floor(Date.now() / 1000),
  type: 'card',
  card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, ...(over.card ?? {}) },
});

export const makeCustomer = (over: Partial<FakeCustomer> = {}): FakeCustomer => ({
  id: over.id ?? 'cus_test',
  email: over.email ?? 'user@example.com',
  metadata: over.metadata ?? {},
  invoice_settings: { default_payment_method: null, ...(over.invoice_settings ?? {}) },
});

export const makeSubscription = (over: Partial<FakeSubscription> = {}): FakeSubscription => {
  // `current_period_end` stays in the overrides for every existing caller, but
  // it lands on the ITEM, which is where Stripe puts it and where the code now
  // reads it. Explicit `items` win, so a fixture can still build an odd shape.
  const periodEnd = over.current_period_end ?? Math.floor(Date.now() / 1000) + 15 * 86400;
  const sub: FakeSubscription = {
    id: over.id ?? nextId('sub'),
    customer: over.customer ?? 'cus_test',
    status: over.status ?? 'active',
    cancel_at_period_end: over.cancel_at_period_end ?? false,
    canceled_at: over.canceled_at ?? null,
    default_payment_method: over.default_payment_method ?? null,
    items: over.items ?? {
      data: [{ id: 'si_test', price: { id: 'price_current' }, current_period_end: periodEnd }],
    },
    metadata: over.metadata ?? {},
    schedule: over.schedule ?? null,
  };
  return sub;
};

export const makeInvoice = (over: Partial<FakeInvoice> = {}): FakeInvoice => ({
  id: over.id ?? nextId('in'),
  customer: over.customer ?? 'cus_test',
  subscription: over.subscription ?? null,
  created: over.created ?? Math.floor(Date.now() / 1000),
  currency: over.currency ?? 'usd',
  amount_paid: over.amount_paid ?? 0,
  amount_due: over.amount_due ?? 0,
  status: over.status ?? 'paid',
  billing_reason: over.billing_reason ?? 'subscription_cycle',
  hosted_invoice_url: over.hosted_invoice_url ?? 'https://invoice.stripe.test/x',
  invoice_pdf: over.invoice_pdf ?? null,
  lines: over.lines ?? { data: [] },
});

export function createFakeStripe(options: FakeStripeOptions = {}) {
  const customers = new Map<string, FakeCustomer>();
  const cards = new Map<string, FakeCard>();
  const subscriptions = new Map<string, FakeSubscription>();
  const invoices = new Map<string, FakeInvoice>();
  const schedules = new Map<string, { id: string; subscription: string; status: string }>();
  const calls: RecordedCall[] = [];

  (options.customers ?? []).forEach((c) => customers.set(c.id, c));
  (options.cards ?? []).forEach((c) => cards.set(c.id, c));
  (options.subscriptions ?? []).forEach((s) => subscriptions.set(s.id, s));
  (options.invoices ?? []).forEach((i) => invoices.set(i.id, i));

  /** Failures a test can arm, keyed by "namespace.method". */
  const failures = new Map<string, Error>();
  /** Artificial delay per method, to exercise races. */
  const delays = new Map<string, number>();

  const record = async (method: string, args: any[]) => {
    calls.push({ method, args });
    const delay = delays.get(method);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const failure = failures.get(method);
    if (failure) throw failure;
  };

  const previewFactory = {
    /** Lines the next invoices.createPreview should return. */
    lines: [] as any[],
    currency: 'usd',
  };

  const api = {
    customers: {
      async create(params: any) {
        await record('customers.create', [params]);
        const c = makeCustomer({ id: nextId('cus'), email: params?.email, metadata: params?.metadata });
        customers.set(c.id, c);
        return c;
      },
      async retrieve(id: string) {
        await record('customers.retrieve', [id]);
        const c = customers.get(id);
        if (!c) throw Object.assign(new Error(`No such customer: ${id}`), { code: 'resource_missing' });
        return c;
      },
      async update(id: string, params: any) {
        await record('customers.update', [id, params]);
        const c = customers.get(id);
        if (!c) throw Object.assign(new Error(`No such customer: ${id}`), { code: 'resource_missing' });
        if (params?.invoice_settings) {
          c.invoice_settings = {
            ...c.invoice_settings,
            ...params.invoice_settings,
          };
        }
        return c;
      },
    },

    paymentMethods: {
      async list({ customer }: { customer: string; type?: string }) {
        await record('paymentMethods.list', [{ customer }]);
        return { data: [...cards.values()].filter((c) => c.customer === customer) };
      },
      async retrieve(id: string) {
        await record('paymentMethods.retrieve', [id]);
        const pm = cards.get(id);
        if (!pm) throw Object.assign(new Error(`No such PaymentMethod: ${id}`), { code: 'resource_missing' });
        return pm;
      },
      async attach(id: string, params: any) {
        await record('paymentMethods.attach', [id, params]);
        const pm = cards.get(id);
        if (pm) pm.customer = params.customer;
        return pm;
      },
      async detach(id: string) {
        await record('paymentMethods.detach', [id]);
        const pm = cards.get(id);
        if (!pm) throw Object.assign(new Error(`No such PaymentMethod: ${id}`), { code: 'resource_missing' });
        const owner = pm.customer;
        pm.customer = null;
        cards.delete(id);
        // Stripe clears the customer default when the default card is detached.
        if (owner) {
          const c = customers.get(owner);
          if (c && c.invoice_settings.default_payment_method === id) {
            c.invoice_settings.default_payment_method = null;
          }
        }
        return pm;
      },
    },

    setupIntents: {
      async create(params: any) {
        await record('setupIntents.create', [params]);
        return { id: nextId('seti'), client_secret: `${nextId('seti')}_secret_test`, customer: params.customer };
      },
    },

    subscriptions: {
      async create(params: any) {
        await record('subscriptions.create', [params]);
        const sub = makeSubscription({
          customer: params.customer,
          status: 'active',
          metadata: params.metadata ?? {},
          items: { data: [{ id: nextId('si'), price: { id: params.items?.[0]?.price } }] },
        });
        sub.latest_invoice = makeInvoice({
          customer: params.customer,
          subscription: sub.id,
          amount_paid: 0,
          status: 'paid',
          billing_reason: 'subscription_create',
        });
        invoices.set(sub.latest_invoice.id, sub.latest_invoice);
        subscriptions.set(sub.id, sub);
        return sub;
      },
      async retrieve(id: string) {
        await record('subscriptions.retrieve', [id]);
        const s = subscriptions.get(id);
        if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
        return s;
      },
      async update(id: string, params: any) {
        await record('subscriptions.update', [id, params]);
        const s = subscriptions.get(id);
        if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
        if (params.cancel_at_period_end !== undefined) {
          s.cancel_at_period_end = params.cancel_at_period_end;
          if (params.cancel_at_period_end === false) s.canceled_at = null;
        }
        if (params.items?.[0]?.price) s.items.data[0].price = { id: params.items[0].price };
        if (params.default_payment_method !== undefined) {
          s.default_payment_method = params.default_payment_method || null;
        }
        return s;
      },
    },

    subscriptionSchedules: {
      async list({ customer }: { customer?: string; scheduled?: boolean }) {
        await record('subscriptionSchedules.list', [{ customer }]);
        const subIds = new Set(
          [...subscriptions.values()].filter((s) => !customer || s.customer === customer).map((s) => s.id),
        );
        return { data: [...schedules.values()].filter((sc) => subIds.has(sc.subscription)) };
      },
      async release(id: string) {
        await record('subscriptionSchedules.release', [id]);
        const sc = schedules.get(id);
        if (sc) {
          sc.status = 'released';
          const sub = subscriptions.get(sc.subscription);
          if (sub) sub.schedule = null;
          schedules.delete(id);
        }
        return sc;
      },
    },

    invoices: {
      async list({ customer, limit }: { customer: string; limit?: number }) {
        await record('invoices.list', [{ customer, limit }]);
        const data = [...invoices.values()]
          .filter((i) => i.customer === customer)
          .sort((a, b) => b.created - a.created)
          .slice(0, limit ?? 10);
        return { data };
      },
      async retrieve(id: string) {
        await record('invoices.retrieve', [id]);
        const i = invoices.get(id);
        if (!i) throw Object.assign(new Error(`No such invoice: ${id}`), { code: 'resource_missing' });
        return i;
      },
      async createPreview(params: any) {
        await record('invoices.createPreview', [params]);
        return {
          currency: previewFactory.currency,
          lines: { data: previewFactory.lines },
        };
      },
    },

    checkout: {
      sessions: {
        async create(params: any) {
          await record('checkout.sessions.create', [params]);
          return { id: nextId('cs'), url: 'https://checkout.stripe.test/session' };
        },
        async retrieve(id: string) {
          await record('checkout.sessions.retrieve', [id]);
          return { id, payment_status: 'paid', status: 'complete', metadata: {}, mode: 'payment' };
        },
      },
    },
  };

  return {
    api,
    calls,
    /** Direct access to the simulated state, for arrange and assert. */
    state: { customers, cards, subscriptions, invoices, schedules },
    preview: previewFactory,
    /** Arm a failure, e.g. failNext('customers.update', new Error('boom')). */
    failNext(method: string, error: Error) {
      failures.set(method, error);
    },
    clearFailure(method: string) {
      failures.delete(method);
    },
    /** Add latency to a method so two concurrent callers genuinely interleave. */
    delay(method: string, ms: number) {
      delays.set(method, ms);
    },
    addSchedule(subscriptionId: string) {
      const id = nextId('sub_sched');
      schedules.set(id, { id, subscription: subscriptionId, status: 'active' });
      const sub = subscriptions.get(subscriptionId);
      if (sub) sub.schedule = id;
      return id;
    },
    addInvoice(inv: FakeInvoice) {
      invoices.set(inv.id, inv);
      return inv;
    },
    callsTo(method: string) {
      return calls.filter((c) => c.method === method);
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
