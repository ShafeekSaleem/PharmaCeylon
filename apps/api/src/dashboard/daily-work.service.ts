import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  DailyWorkKind,
  DailyWorkResponse,
  WorkCategory,
} from "@pharmaceylon/shared";
import { businessToday, safeTimeZone } from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { POS_ROLLOUT_SELECT, resolvePosRollout } from "../tenant/pos-rollout";
import { counterKinds } from "./daily-work-kinds";
import { DailyWorkQueryDto } from "./dto/daily-work-query.dto";

const PAGE_SIZE = 6;

/** A read model of real workflows. No independent task-completion state to drift from stock/money. */
@Injectable()
export class DailyWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async get(
    user: RequestUser,
    branchId: string,
    query: DailyWorkQueryDto,
    /** Server callers (notifications) read more than a page, or only some kinds. */
    opts: { pageSize?: number; kinds?: readonly DailyWorkKind[] } = {},
  ): Promise<DailyWorkResponse> {
    const pageSize = opts.pageSize ?? PAGE_SIZE;
    const actor = await this.access.resolve(user, branchId);
    const branch = await this.prisma.branch.findFirst({
      where: { tenantId: user.tenantId, id: branchId },
      select: { name: true, timezone: true, ...POS_ROLLOUT_SELECT },
    });
    if (!branch) throw new NotFoundException("Branch not found");
    const timezone = safeTimeZone(branch.timezone);
    const now = new Date();
    const rollout = resolvePosRollout(branch, now).state;
    const counterLive = rollout !== "not_live";
    const today = businessToday(timezone, now);
    const tenant = user.tenantId;
    const uid = user.userId;
    const sources: Prisma.Sql[] = [];
    const allowed = (...keys: string[]) => keys.every((key) => actor.has(key));
    const blocked = (creator: Prisma.Sql) =>
      Prisma.sql`(NOT ${actor.canSelfApprove} AND ${creator} = ${uid}::uuid)`;
    // @db.Date deadlines are inclusive business dates, not UTC instants at midnight.
    const deadline = (date: Prisma.Sql) =>
      Prisma.sql`((${date}::date + interval '1 day' - interval '1 millisecond') AT TIME ZONE ${timezone}) AT TIME ZONE 'UTC'`;

    if (allowed("purchasing.view")) {
      const approve = actor.has("purchasing.approve");
      const receive = actor.has("purchasing.receive");
      const manage = actor.has("purchasing.manage");
      sources.push(Prisma.sql`
        SELECT 'po:' || p.id AS id,
          CASE WHEN p.status = 'pending_approval' THEN 'purchase_order.approve' WHEN p.status = 'draft' THEN 'purchase_order.draft' ELSE 'purchase_order.receive' END AS kind,
          'purchasing' AS category,
          CASE WHEN p.status = 'pending_approval' THEN 'Review purchase order'
            WHEN p.status = 'draft' THEN 'Finish purchase order' ELSE 'Receive purchase order' END AS title,
          s.name AS detail, p.po_number AS reference, p.status::text AS status,
          '/purchasing?po=' || p.id AS href,
          CASE WHEN p.status = 'pending_approval' THEN 'Review order' WHEN p.status = 'draft' THEN 'Continue order' ELSE 'Open receiving' END AS action,
          p.created_at AS created_at, ${deadline(Prisma.sql`p.expected_on`)} AS due_at,
          CASE WHEN p.status = 'pending_approval' THEN 'Branch approvers' WHEN p.status = 'draft' THEN u.full_name ELSE 'Receiving team' END AS owner,
          (p.status = 'draft' AND p.created_by = ${uid}::uuid) AS mine,
          (p.status = 'pending_approval') AS approval,
          (p.status = 'pending_approval' AND ${blocked(Prisma.sql`p.created_by`)}) AS blocked,
          CASE WHEN p.priority = 'urgent' THEN 0 WHEN p.priority = 'high' THEN 1 ELSE 2 END AS priority
        FROM purchase_order p JOIN supplier s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
          JOIN app_user u ON u.id = p.created_by
        WHERE p.tenant_id = ${tenant}::uuid AND p.branch_id = ${branchId}::uuid AND (
          (${approve} AND p.status = 'pending_approval') OR
          (${manage} AND p.status = 'draft' AND p.created_by = ${uid}::uuid) OR
          (${receive} AND p.status IN ('issued', 'partially_received')))`);
      if (approve || receive)
        sources.push(Prisma.sql`
        SELECT 'delivery:' || h.id, CASE WHEN h.status = 'approved' THEN 'held_delivery.post' ELSE 'held_delivery.approve' END, 'purchasing', CASE WHEN h.status = 'approved' THEN 'Post approved delivery' ELSE 'Review held delivery' END,
          concat(p.po_number, ' · ', array_to_string(h.reasons, ', ')), p.po_number, h.status::text,
          '/purchasing?po=' || p.id || '&held=' || h.id, CASE WHEN h.status = 'approved' THEN 'Post receipt' ELSE 'Review delivery' END, h.requested_at, NULL::timestamp,
          CASE WHEN h.status = 'approved' THEN 'Receiving team' ELSE 'Branch approvers' END, false,
          (h.status = 'awaiting_approval'), (h.status = 'awaiting_approval' AND ${blocked(Prisma.sql`h.requested_by`)}), 1
        FROM held_delivery h JOIN purchase_order p ON p.id = h.purchase_order_id AND p.tenant_id = h.tenant_id AND p.branch_id = h.branch_id
        WHERE h.tenant_id = ${tenant}::uuid AND h.branch_id = ${branchId}::uuid AND ((h.status = 'awaiting_approval' AND ${approve}) OR (h.status = 'approved' AND ${receive}))`);
    }
    if (allowed("inventory.view", "inventory.write_off"))
      sources.push(Prisma.sql`
      SELECT 'adjustment:' || h.id, CASE WHEN h.status = 'approved' THEN 'held_adjustment.post' ELSE 'held_adjustment.approve' END, 'inventory', CASE WHEN h.status = 'approved' THEN 'Post approved write-off' ELSE 'Review write-off request' END,
        concat(p.name, ' · ', h.qty, ' units · ', h.kind), b.batch_no, h.status::text,
        '/inventory?heldAdjustment=' || h.id, CASE WHEN h.status = 'approved' THEN 'Post write-off' ELSE 'Review write-off' END, h.requested_at, NULL::timestamp,
        'Branch approvers', false, (h.status = 'awaiting_approval'),
        (h.status = 'awaiting_approval' AND ${blocked(Prisma.sql`h.requested_by`)}), 1
      FROM held_adjustment h JOIN product p ON p.id = h.product_id AND p.tenant_id = h.tenant_id
        JOIN batch b ON b.id = h.batch_id AND b.tenant_id = h.tenant_id AND b.branch_id = h.branch_id
      WHERE h.tenant_id = ${tenant}::uuid AND h.branch_id = ${branchId}::uuid AND h.status IN ('awaiting_approval','approved')`);

    if (allowed("transfers.view"))
      sources.push(Prisma.sql`
      SELECT 'transfer:' || t.id,
        CASE WHEN t.status = 'requested' THEN 'transfer.approve' WHEN t.status = 'approved' THEN 'transfer.ship' ELSE 'transfer.receive' END, 'transfers',
        CASE WHEN t.status = 'requested' THEN 'Review transfer request'
          WHEN t.status = 'approved' THEN 'Dispatch approved transfer' ELSE 'Receive incoming transfer' END,
        concat(f.name, ' → ', b.name), t.transfer_number, t.status::text,
        '/transfers?transfer=' || t.id,
        CASE WHEN t.status = 'requested' THEN 'Review transfer' WHEN t.status = 'approved' THEN 'Open dispatch' ELSE 'Open receiving' END,
        t.created_at, ${deadline(Prisma.sql`t.expected_on`)},
        CASE WHEN t.status = 'requested' THEN 'Branch approvers' WHEN t.status = 'approved' THEN 'Dispatch team' ELSE 'Receiving team' END,
        false, (t.status = 'requested'), (t.status = 'requested' AND ${blocked(Prisma.sql`t.requested_by`)}), 2
      FROM transfer t JOIN branch f ON f.id = t.from_branch_id AND f.tenant_id = t.tenant_id
        JOIN branch b ON b.id = t.to_branch_id AND b.tenant_id = t.tenant_id
      WHERE t.tenant_id = ${tenant}::uuid AND (
        (t.from_branch_id = ${branchId}::uuid AND ((${actor.has("transfers.approve")} AND t.status = 'requested') OR (${actor.has("transfers.manage")} AND t.status = 'approved')))
        OR (t.to_branch_id = ${branchId}::uuid AND ${actor.has("transfers.manage")} AND t.status IN ('in_transit', 'partially_received')))`);

    if (allowed("returns.view"))
      sources.push(Prisma.sql`
      SELECT 'return:' || r.id,
        CASE WHEN r.status = 'pending_approval' THEN 'goods_return.approve' WHEN r.status = 'draft' THEN 'goods_return.draft' ELSE 'goods_return.complete' END, 'returns',
        CASE WHEN r.status = 'pending_approval' THEN 'Review supplier return' WHEN r.status = 'draft' THEN 'Finish supplier return' ELSE 'Continue supplier return' END,
        COALESCE(s.name, 'Supplier return'), r.return_number, r.status::text, '/returns?return=' || r.id,
        CASE WHEN r.status = 'pending_approval' THEN 'Review return' ELSE 'Continue return' END,
        r.created_at, NULL::timestamp,
        CASE WHEN r.status = 'pending_approval' THEN 'Branch approvers' WHEN r.status = 'draft' THEN u.full_name ELSE 'Returns team' END,
        (r.status != 'pending_approval' AND r.requested_by = ${uid}::uuid), (r.status = 'pending_approval'),
        (r.status = 'pending_approval' AND ${blocked(Prisma.sql`r.requested_by`)}), 2
      FROM goods_return r LEFT JOIN supplier s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id
        JOIN app_user u ON u.id = r.requested_by
      WHERE r.tenant_id = ${tenant}::uuid AND r.branch_id = ${branchId}::uuid AND r.type = 'supplier' AND (
        (${actor.has("returns.approve")} AND r.status = 'pending_approval') OR
        (${actor.has("returns.process")} AND (r.status IN ('awaiting_logistics', 'in_review') OR (r.status = 'draft' AND r.requested_by = ${uid}::uuid))))`);

    if (allowed("stocktakes.use")) {
      const review = Prisma.sql`s.status IN ('submitted', 'under_review', 'approved', 'posted')`;
      const needsApproval = Prisma.sql`(s.status IN ('submitted', 'under_review') OR (s.status = 'approved' AND s.execution_approval_id IS NULL))`;
      sources.push(Prisma.sql`
        SELECT 'stocktake:' || s.id,
          CASE WHEN ${needsApproval} THEN 'stocktake.approve' WHEN s.status = 'approved' THEN 'stocktake.post' WHEN s.status = 'posted' THEN 'stocktake.complete'
            WHEN s.status = 'counting' THEN 'stocktake.count' ELSE 'stocktake.prepare' END, 'stocktakes',
          CASE WHEN s.status = 'approved' AND s.execution_approval_id IS NULL THEN 'Review legacy stocktake approval' WHEN s.status = 'approved' THEN 'Post approved stocktake' WHEN s.status = 'posted' THEN 'Complete posted stocktake'
            WHEN ${review} THEN 'Review stocktake' WHEN s.status = 'counting' THEN 'Continue stock count' ELSE 'Prepare stock count' END,
          concat(COALESCE(s.title, 'Stocktake'), CASE WHEN s.area_label IS NOT NULL THEN ' · ' || s.area_label ELSE '' END),
          s.stocktake_number, s.status::text, '/stocktakes/' || s.id,
          CASE WHEN ${review} THEN 'Open review' WHEN s.status = 'counting' THEN 'Resume count' ELSE 'Open stocktake' END,
          s.created_at, COALESCE(s.expected_completion_at, CASE WHEN s.status IN ('draft', 'scheduled') THEN s.scheduled_for END),
          CASE WHEN ${review} THEN COALESCE(reviewer.full_name, 'Branch reviewers') ELSE counter.full_name END,
          CASE WHEN ${review} THEN s.reviewer_id = ${uid}::uuid ELSE
            (s.counted_by = ${uid}::uuid OR EXISTS(SELECT 1 FROM stocktake_assignment a WHERE a.tenant_id = ${tenant}::uuid AND a.stocktake_id = s.id AND a.user_id = ${uid}::uuid)) END,
          (${needsApproval}) AS approval,
          (${needsApproval} AND NOT ${actor.canSelfApprove} AND (s.counted_by = ${uid}::uuid OR EXISTS(
            SELECT 1 FROM stocktake_count_entry e WHERE e.tenant_id = ${tenant}::uuid AND e.stocktake_id = s.id AND e.counted_by = ${uid}::uuid))), 2
        FROM stocktake s JOIN app_user counter ON counter.id = s.counted_by LEFT JOIN app_user reviewer ON reviewer.id = s.reviewer_id
        WHERE s.tenant_id = ${tenant}::uuid AND s.branch_id = ${branchId}::uuid AND (
          (${actor.has("stocktakes.review")} AND ${review}) OR
          (s.status IN ('draft', 'scheduled', 'counting') AND (${actor.has("stocktakes.review")} OR s.counted_by = ${uid}::uuid OR EXISTS(
            SELECT 1 FROM stocktake_assignment a WHERE a.tenant_id = ${tenant}::uuid AND a.stocktake_id = s.id AND a.user_id = ${uid}::uuid))))`);
    }
    // Held bills live in the web POS. At a live branch it is hidden, so they leave the web (W9);
    // during a fallback the web POS is back and so are its holds.
    if (allowed("sales.pos_use") && rollout !== "live") {
      const pharmacist = Prisma.sql`(h.payload #>> '{meta,needsPharmacist}' = 'true' OR h.payload #>> '{meta,holdReason}' = 'awaiting_pharmacist')`;
      sources.push(Prisma.sql`
        SELECT 'hold:' || h.id, CASE WHEN ${pharmacist} THEN 'held_sale.pharmacist_review' ELSE 'held_sale.resume' END, 'counter', CASE WHEN ${pharmacist} THEN 'Pharmacist review requested' ELSE 'Resume held bill' END,
          concat(COALESCE(h.label, h.hold_ref), ' · ', h.item_count, ' items'), h.hold_ref,
          CASE WHEN ${pharmacist} THEN 'needs_review' ELSE 'held' END,
          '/pos?panel=holds&holdId=' || h.id,
          CASE WHEN ${pharmacist} AND ${actor.has("sales.approve_controlled")} THEN 'Review hold' ELSE 'Open held bill' END,
          h.created_at, NULL::timestamp, u.full_name, (h.held_by = ${uid}::uuid), false, false,
          CASE WHEN ${pharmacist} THEN 1 ELSE 2 END
        FROM held_sale h JOIN app_user u ON u.id = h.held_by
        WHERE h.tenant_id = ${tenant}::uuid AND h.branch_id = ${branchId}::uuid AND (
          h.held_by = ${uid}::uuid OR (${actor.has("sales.approve_controlled")} AND ${pharmacist}))`);
    }
    // Staged opening stock (D-W2, #79) waits to be posted, in one go or by category.
    if (allowed("products.import"))
      sources.push(Prisma.sql`
      SELECT 'import:' || i.id, 'import_stock.post', 'inventory', 'Post staged opening stock',
        concat(i.filename, ' · ', (SELECT count(*) FROM jsonb_array_elements(i.staged_stock) r WHERE r->>'postedBatchId' IS NULL), ' rows to post'),
        i.filename, 'staged', '/products?importId=' || i.id, 'Open import', i.created_at, NULL::timestamp,
        COALESCE(u.full_name, 'Stock team'), (COALESCE(i.stock_staged_by, i.created_by) = ${uid}::uuid), false, false, 2
      FROM product_import i LEFT JOIN app_user u ON u.id = COALESCE(i.stock_staged_by, i.created_by)
      WHERE i.tenant_id = ${tenant}::uuid AND i.branch_id = ${branchId}::uuid AND i.stock_staged AND i.status = 'completed'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.staged_stock) r WHERE r->>'postedBatchId' IS NULL)`);
    if (allowed("inventory.view", "inventory.quarantine"))
      sources.push(Prisma.sql`
      SELECT 'expiry:' || b.id, 'batch.expiry_review', 'inventory', CASE WHEN b.expiry_date < ${today}::date THEN 'Isolate expired stock' ELSE 'Review near-expiry batch' END,
        concat(p.name, ' · ', (bs.on_hand_qty - bs.quarantined_qty), ' units'), b.batch_no,
        CASE WHEN b.expiry_date < ${today}::date THEN 'expired' ELSE 'near_expiry' END,
        '/inventory?stock=' || b.product_id, 'Review batch', b.created_at,
        ${deadline(Prisma.sql`b.expiry_date`)}, 'Stock team', false, false, false,
        CASE WHEN b.expiry_date < ${today}::date THEN 0 ELSE 3 END
      FROM batch b JOIN batch_stock bs ON bs.batch_id = b.id AND bs.tenant_id = b.tenant_id AND bs.branch_id = b.branch_id
        JOIN product p ON p.id = b.product_id AND p.tenant_id = b.tenant_id
      WHERE b.tenant_id = ${tenant}::uuid AND b.branch_id = ${branchId}::uuid AND NOT b.needs_expiry_review
        AND b.expiry_date <= ${today}::date + 30 AND bs.on_hand_qty > bs.quarantined_qty`);

    if (sources.length === 0)
      return {
        items: [],
        total: 0,
        page: query.page,
        pageSize,
        counts: { all: 0, mine: 0, approvals: 0, overdue: 0, counter: 0 },
        categories: {},
        asOf: now.toISOString(),
        timezone,
        branchName: branch.name,
        counterLive,
      };
    const filter =
      query.filter === "mine"
        ? Prisma.sql`mine`
        : query.filter === "approvals"
          ? Prisma.sql`approval AND NOT blocked`
          : query.filter === "overdue"
            ? Prisma.sql`overdue`
            : query.filter === "counter"
              ? Prisma.sql`place = 'counter'`
              : Prisma.sql`true`;
    const atCounter = counterKinds(counterLive);
    const place = atCounter.length
      ? Prisma.sql`CASE WHEN kind IN (${Prisma.join(atCounter)}) THEN 'counter' ELSE 'web' END`
      : Prisma.sql`'web'`;
    const category = Prisma.sql`${
      query.category ? Prisma.sql`category = ${query.category}` : Prisma.sql`true`
    } AND ${
      opts.kinds
        ? opts.kinds.length
          ? Prisma.sql`kind IN (${Prisma.join([...opts.kinds])})`
          : Prisma.sql`false`
        : Prisma.sql`true`
    }`;
    // One statement: page, total and filter counts describe the same database snapshot.
    const [result] = await this.prisma.$queryRaw<
      Array<{
        items: DailyWorkResponse["items"];
        total: number;
        counts: DailyWorkResponse["counts"];
        categories: Partial<Record<WorkCategory, number>>;
      }>
    >(Prisma.sql`
      WITH work (id, kind, category, title, detail, reference, status, href, action, created_at, due_at, owner, mine, approval, blocked, priority)
        AS (${Prisma.join(sources, " UNION ALL ")}),
      classified AS (SELECT *, COALESCE(due_at <= ${now}::timestamp, false) AS overdue, ${place} AS place FROM work),
      scoped AS (SELECT * FROM classified WHERE ${category}),
      filtered AS (SELECT * FROM scoped WHERE ${filter}),
      page AS (SELECT * FROM filtered ORDER BY blocked ASC, overdue DESC, priority, (approval AND NOT blocked) DESC,
        mine DESC NULLS LAST, due_at ASC NULLS LAST, created_at, id LIMIT ${pageSize} OFFSET ${(query.page - 1) * pageSize})
      SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'kind', kind, 'where', place, 'category', category, 'title', title, 'detail', detail, 'reference', reference, 'status', status,
        'href', href, 'action', CASE WHEN blocked THEN 'View request' WHEN place = 'counter' THEN 'View details' ELSE action END,
        'createdAt', to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'dueAt', CASE WHEN due_at IS NULL THEN NULL ELSE to_char(due_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        'owner', CASE WHEN blocked THEN 'Another approver needed' ELSE owner END,
        'mine', COALESCE(mine, false), 'approval', approval, 'blocked', blocked, 'overdue', overdue, 'priority', priority
      )) FROM page), '[]'::jsonb) AS items,
      (SELECT count(*)::int FROM filtered) AS total,
      (SELECT jsonb_build_object('all', count(*), 'mine', count(*) FILTER (WHERE mine),
        'approvals', count(*) FILTER (WHERE approval AND NOT blocked), 'overdue', count(*) FILTER (WHERE overdue),
        'counter', count(*) FILTER (WHERE place = 'counter')) FROM scoped) AS counts,
      COALESCE((SELECT jsonb_object_agg(category, n) FROM (SELECT category, count(*)::int n FROM classified GROUP BY category) c), '{}'::jsonb) AS categories`);
    return {
      ...result,
      page: query.page,
      pageSize,
      asOf: now.toISOString(),
      timezone,
      branchName: branch.name,
      counterLive,
    };
  }
}
