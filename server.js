require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing from .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const rendererPath = path.join(__dirname, "../src/renderer");
app.use(express.static(rendererPath));
app.get("/", (req, res) => res.sendFile(path.join(rendererPath, "index.html")));

const TABLES = [
  "branches", "users", "products", "customers", "suppliers", "sales",
  "sale_items", "payments", "installments", "expenses",
  "stock_movements", "settings", "audit_logs"
];

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const allowed = (t) => TABLES.includes(t);

function safeCurrency(value, fallback = 'UGX') {
  const v = String(value ?? '').trim();
  return v || fallback;
}

function safeDate(value, fallback = new Date().toISOString()) {
  const d = new Date(value || fallback);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function safeMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

async function ensureBranch(client) {
  const r = await client.query(`SELECT id FROM branches ORDER BY created_at NULLS LAST LIMIT 1`);
  if (r.rows[0]) return r.rows[0].id;
  const x = await client.query(`
    INSERT INTO branches (name, currency, is_active)
    VALUES ('CATCH STORE', 'UGX', true)
    RETURNING id
  `);
  return x.rows[0].id;
}

async function ensureAdmin(client, branchId) {
  const r = await client.query(`SELECT * FROM users WHERE username = 'admin' LIMIT 1`);
  if (r.rows[0]) {
    // Supabase schema allows: manager, cashier, admin.
    // The frontend displays the admin role as Administrator.
    if (r.rows[0].role !== 'admin') {
      const fixed = await client.query(`
        UPDATE users SET role = 'admin', branch_id = $1, is_active = true
        WHERE id = $2 RETURNING *
      `, [branchId, r.rows[0].id]);
      return fixed.rows[0];
    }
    return r.rows[0];
  }
  const x = await client.query(`
    INSERT INTO users (branch_id, name, username, phone, password_hash, role, is_active)
    VALUES ($1, 'المدير', 'admin', '', '1234', 'admin', true)
    RETURNING *
  `, [branchId]);
  return x.rows[0];
}

function toFrontendUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    phone: u.phone || "",
    password: u.password_hash || "",
    role: (u.role === 'admin' ? 'Administrator' : (u.role || 'Cashier')),
    status: u.is_active ? "Active" : "Inactive"
  };
}

async function ensurePurchasesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.purchases (
      id uuid PRIMARY KEY,
      branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL,
      number varchar(100) NOT NULL UNIQUE,
      purchase_date timestamptz NOT NULL DEFAULT now(),
      supplier_id uuid,
      supplier_name varchar(255),
      currency varchar(20) NOT NULL DEFAULT 'UGX',
      total numeric(14,2) NOT NULL DEFAULT 0,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function bootstrap() {
  const client = await pool.connect();
  try {
    const branchId = await ensureBranch(client);
    await ensureAdmin(client, branchId);
    await ensurePurchasesTable(client);

    const [products, customers, suppliers, expenses, users, settings, sales, saleItems, payments, purchases] = await Promise.all([
      client.query(`SELECT * FROM products ORDER BY created_at DESC`),
      client.query(`SELECT * FROM customers ORDER BY created_at DESC`),
      client.query(`SELECT * FROM suppliers ORDER BY created_at DESC`),
      client.query(`SELECT * FROM expenses ORDER BY expense_date DESC, created_at DESC`),
      client.query(`SELECT * FROM users ORDER BY created_at DESC`),
      client.query(`SELECT * FROM settings ORDER BY created_at DESC LIMIT 1`),
      client.query(`SELECT * FROM sales ORDER BY created_at DESC`),
      client.query(`SELECT * FROM sale_items ORDER BY created_at ASC`),
      client.query(`SELECT * FROM payments ORDER BY payment_date DESC, created_at DESC`),
      client.query(`SELECT * FROM public.purchases WHERE branch_id = $1 ORDER BY purchase_date DESC, created_at DESC`, [branchId])
    ]);

    const customerMap = new Map(customers.rows.map(c => [c.id, c]));
    const itemsMap = new Map();
    for (const i of saleItems.rows) {
      if (!itemsMap.has(i.sale_id)) itemsMap.set(i.sale_id, []);
      const p = await client.query(`SELECT name, currency FROM products WHERE id = $1 LIMIT 1`, [i.product_id]);
      const product = p.rows[0] || {};
      itemsMap.get(i.sale_id).push({
        id: i.product_id,
        name: product.name || "",
        qty: Number(i.quantity || 0),
        price: Number(i.unit_price || 0),
        currency: safeCurrency(i.currency, product.currency || 'UGX')
      });
    }

    const saleMap = new Map();
    const frontendSales = sales.rows.map(s => {
      const c = customerMap.get(s.customer_id);
      const sale = {
        id: s.id,
        invoice: s.invoice_number,
        date: s.created_at,
        customerId: s.customer_id || "",
        customerName: c?.name || "عميل نقدي / Walk-in",
        type: s.sale_type || "cash",
        currency: s.currency || "UGX",
        paymentMethod: s.payment_method || "Cash",
        items: itemsMap.get(s.id) || [],
        total: Number(s.total || 0),
        paid: Number(s.paid || 0),
        remaining: Number(s.balance || 0),
        installmentCount: 0,
        installmentAmount: 0
      };
      saleMap.set(s.id, sale);
      return sale;
    });

    for (const s of frontendSales) {
      if (s.type === "installment") {
        const ins = await client.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS amount FROM installments WHERE sale_id = $1`, [s.id]);
        s.installmentCount = Number(ins.rows[0]?.count || 0);
        s.installmentAmount = s.installmentCount ? Number(ins.rows[0].amount || 0) / s.installmentCount : 0;
      }
    }

    const set = settings.rows[0] || {};
    return {
      products: products.rows.map(p => ({
        id: p.id,
        name: p.name,
        sku: p.sku || "",
        category: p.category || "Phones",
        brand: p.brand || "",
        qty: Number(p.quantity || 0),
        min: Number(p.minimum_quantity || 0),
        buy: Number(p.cost_price || 0),
        sell: Number(p.selling_price || 0),
        currency: safeCurrency(p.currency, 'UGX')
      })),
      customers: customers.rows.map(c => ({
        id: c.id, name: c.name, phone: c.phone || "", whatsapp: c.whatsapp || "",
        email: c.email || "", address: c.address || ""
      })),
      sales: frontendSales,
      payments: payments.rows.map(p => {
        const s = saleMap.get(p.sale_id);
        return {
          id: p.id, date: p.payment_date || p.created_at, saleId: p.sale_id,
          invoice: s?.invoice || "", customerId: p.customer_id || s?.customerId || "",
          customerName: s?.customerName || "", amount: Number(p.amount || 0),
          currency: safeCurrency(s?.currency, 'UGX'), method: p.payment_method || "Cash", note: p.notes || ""
        };
      }),
      suppliers: suppliers.rows.map(s => ({
        id: s.id, name: s.name, company: s.company_name || "", phone: s.phone || "",
        whatsapp: s.whatsapp || "", email: s.email || "", notes: s.notes || ""
      })),
      purchases: purchases.rows.map(p => ({
        id: p.id, number: p.number, date: p.purchase_date,
        supplierId: p.supplier_id || "", supplierName: p.supplier_name || "",
        currency: safeCurrency(p.currency, 'UGX'), total: Number(p.total || 0),
        items: Array.isArray(p.items) ? p.items : [], notes: p.notes || ""
      })),
      expenses: expenses.rows.map(e => ({
        id: e.id, date: e.expense_date, type: e.category || e.title || "أخرى",
        amount: Number(e.amount || 0), currency: safeCurrency(e.currency, 'UGX'), description: e.description || ""
      })),
      users: users.rows.map(toFrontendUser),
      settings: {
        storeName: set.store_name || "CATCH STORE",
        phone: set.phone || "",
        email: set.email || "",
        currency: set.default_currency || "UGX",
        logo: set.logo_url || ""
      }
    };
  } finally {
    client.release();
  }
}

async function upsert(client, table, data) {
  const keys = Object.keys(data).filter(k => data[k] !== undefined);
  if (!keys.length) return;
  const vals = keys.map(k => data[k]);
  const cols = keys.map(qi).join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const updates = keys.filter(k => k !== "id").map(k => `${qi(k)} = EXCLUDED.${qi(k)}`).join(", ");
  const sql = `INSERT INTO ${qi(table)} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates || 'id = EXCLUDED.id'}`;
  await client.query(sql, vals);
}

async function syncDB(db) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const branchId = await ensureBranch(client);
    await ensurePurchasesTable(client);
    const admin = await ensureAdmin(client, branchId);
    const now = new Date().toISOString();

    for (const p of (db.products || [])) {
      await upsert(client, "products", {
        id: p.id, branch_id: branchId, name: p.name, category: p.category || null,
        brand: p.brand || null, model: null, sku: p.sku || null, barcode: null,
        description: null, quantity: Number(p.qty || 0), minimum_quantity: Number(p.min || 0),
        cost_price: Number(p.buy || 0), selling_price: Number(p.sell || 0), currency: safeCurrency(p.currency, 'UGX'),
        is_active: true, updated_at: now
      });
    }

    for (const c of (db.customers || [])) {
      await upsert(client, "customers", {
        id: c.id, branch_id: branchId, name: c.name, phone: c.phone || null,
        whatsapp: c.whatsapp || null, email: c.email || null, national_id: null,
        address: c.address || null, notes: null, is_active: true, updated_at: now
      });
    }

    for (const s of (db.suppliers || [])) {
      await upsert(client, "suppliers", {
        id: s.id, branch_id: branchId, name: s.name, phone: s.phone || null,
        whatsapp: s.whatsapp || null, company_name: s.company || null, email: s.email || null,
        address: null, notes: s.notes || null, is_active: true, updated_at: now
      });
    }

    const incomingPurchases = Array.isArray(db.purchases) ? db.purchases : [];
    if (incomingPurchases.length === 0) {
      await client.query(`DELETE FROM public.purchases WHERE branch_id = $1`, [branchId]);
    } else {
      const ids = incomingPurchases.map(x => x?.id).filter(Boolean);
      if (ids.length) {
        await client.query(`DELETE FROM public.purchases WHERE branch_id = $1 AND NOT (id = ANY($2::uuid[]))`, [branchId, ids]);
      }
      for (const p of incomingPurchases) {
        if (!p?.id) continue;
        await upsert(client, "purchases", {
          id: p.id,
          branch_id: branchId,
          number: String(p.number || `PUR-${String(p.id).slice(0,8)}`),
          purchase_date: safeDate(p.date, now),
          supplier_id: p.supplierId || null,
          supplier_name: p.supplierName || null,
          currency: safeCurrency(p.currency, 'UGX'),
          total: safeMoney(p.total),
          items: JSON.stringify(Array.isArray(p.items) ? p.items : []),
          notes: p.notes || null,
          updated_at: now
        });
      }
    }

    for (const e of (db.expenses || [])) {
      await upsert(client, "expenses", {
        id: e.id, branch_id: branchId, created_by: admin.id, title: e.type || "أخرى",
        category: e.type || "أخرى", description: e.description || null, amount: Number(e.amount || 0),
        currency: safeCurrency(e.currency, 'UGX'), expense_date: e.date || now.slice(0,10),
        payment_method: null, updated_at: now
      });
    }

    for (const u of (db.users || [])) {
      if (!u.id) continue;
      await upsert(client, "users", {
        id: u.id, branch_id: branchId, name: u.name, username: u.username,
        email: null, phone: u.phone || null, password_hash: u.password || "",
        role: (u.role === 'Administrator' ? 'admin' : (u.role === 'Manager' ? 'manager' : (u.role === 'Cashier' ? 'cashier' : 'cashier'))), is_active: u.status !== "Inactive", updated_at: now
      });
    }

    const settingRows = await client.query(`SELECT id FROM settings ORDER BY created_at LIMIT 1`);
    const settingId = settingRows.rows[0]?.id || crypto.randomUUID();
    await upsert(client, "settings", {
      id: settingId, branch_id: branchId, store_name: db.settings?.storeName || "CATCH STORE",
      phone: db.settings?.phone || null, email: db.settings?.email || null, address: null,
      logo_url: db.settings?.logo || null, default_currency: safeCurrency(db.settings?.currency, 'UGX'),
      invoice_prefix: "INV", receipt_footer: null, updated_at: now
    });

    // Capture the database stock BEFORE syncing the frontend quantities.
    // This lets us record exactly how much stock a new sale consumed.
    const stockBefore = new Map();
    const productRowsBefore = await client.query(`SELECT id, quantity FROM products WHERE branch_id = $1`, [branchId]);
    for (const row of productRowsBefore.rows) {
      stockBefore.set(String(row.id), safeInt(row.quantity));
    }

    // Remember which sales already existed before this sync.
    // Stock movements are created only for genuinely new sales, so an
    // ordinary repeated sync can never create duplicate or false movements.
    const existingSaleRows = await client.query(`SELECT id FROM sales WHERE branch_id = $1`, [branchId]);
    const existingSaleIds = new Set(existingSaleRows.rows.map(row => String(row.id)));

    const syncedSales = new Map();

    for (const s of (db.sales || [])) {
      if (!s?.id) continue;
      const saleCurrency = safeCurrency(s.currency, safeCurrency(db.settings?.currency, 'UGX'));
      const total = safeMoney(s.total);
      const paid = safeMoney(s.paid);
      const remaining = Math.max(0, safeMoney(s.remaining));
      const saleStatus = remaining > 0 ? 'pending' : 'completed';
      const invoice = String(s.invoice || `INV-${String(s.id).slice(0, 8)}`);

      await upsert(client, "sales", {
        id: s.id,
        customer_id: s.customerId || null,
        branch_id: branchId,
        invoice_number: invoice,
        sale_type: s.type || "cash",
        currency: saleCurrency,
        subtotal: total,
        discount: 0,
        total,
        paid,
        balance: remaining,
        payment_method: s.paymentMethod || "Cash",
        cashier_id: admin.id,
        notes: null,
        status: saleStatus,
        updated_at: now
      });
      syncedSales.set(s.id, { currency: saleCurrency, customerId: s.customerId || null, invoice });

      await client.query(`DELETE FROM sale_items WHERE sale_id = $1`, [s.id]);
      for (const item of (Array.isArray(s.items) ? s.items : [])) {
        if (!item) continue;
        let productId = item.id || null;
        if (productId) {
          const check = await client.query(`SELECT id FROM products WHERE id = $1 LIMIT 1`, [productId]);
          if (!check.rows.length) productId = null;
        }
        if (!productId && item.name) {
          const byName = await client.query(
            `SELECT id FROM products WHERE branch_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1`,
            [branchId, String(item.name)]
          );
          productId = byName.rows[0]?.id || null;
        }
        if (!productId) {
          console.warn(`Skipping sale item without a valid product: ${item.name || 'unknown'}`);
          continue;
        }
        const productRow = await client.query(`SELECT name, currency FROM products WHERE id = $1 LIMIT 1`, [productId]);
        const productName = String(item.name || productRow.rows[0]?.name || 'Product');
        const itemCurrency = safeCurrency(item.currency, saleCurrency || productRow.rows[0]?.currency || 'UGX');
        const quantity = Math.max(0, safeInt(item.qty));
        const unitPrice = Math.max(0, safeMoney(item.price));
        await upsert(client, "sale_items", {
          id: crypto.randomUUID(),
          sale_id: s.id,
          product_id: productId,
          product_name: productName,
          quantity,
          unit_price: unitPrice,
          total: quantity * unitPrice,
          currency: itemCurrency
        });

        // Create one stock-movement record for this sale item, but only once.
        // Repeated /api/sync calls must not create duplicate movements.
        if (quantity > 0 && !existingSaleIds.has(String(s.id))) {
          const existingMovement = await client.query(
            `SELECT id FROM stock_movements
             WHERE product_id = $1
               AND reference_id = $2
               AND reference_type = 'sale'
             LIMIT 1`,
            [productId, s.id]
          );

          if (!existingMovement.rows.length) {
            const previousQuantity = stockBefore.has(String(productId))
              ? stockBefore.get(String(productId))
              : safeInt((await client.query(`SELECT quantity FROM products WHERE id = $1 LIMIT 1`, [productId])).rows[0]?.quantity);
            const newQuantity = Math.max(0, previousQuantity - quantity);

            await client.query(`
              INSERT INTO stock_movements
                (id, product_id, branch_id, user_id, movement_type, quantity,
                 previous_quantity, new_quantity, reference_id, reference_type, notes)
              VALUES
                ($1, $2, $3, $4, 'sale', $5, $6, $7, $8, 'sale', $9)
            `, [
              crypto.randomUUID(),
              productId,
              branchId,
              admin.id,
              -quantity,
              previousQuantity,
              newQuantity,
              s.id,
              `Sale ${invoice}`
            ]);

            // Keep the in-memory quantity correct if the same product appears
            // more than once in the same sale.
            stockBefore.set(String(productId), newQuantity);
          }
        }
      }
    }

    for (const p of (db.payments || [])) {
      if (!p?.id) continue;
      const saleInfo = p.saleId ? syncedSales.get(p.saleId) : null;
      const paymentCurrency = safeCurrency(p.currency, saleInfo?.currency || safeCurrency(db.settings?.currency, 'UGX'));
      const paymentDate = safeDate(p.date, now);
      await upsert(client, "payments", {
        id: p.id,
        sale_id: p.saleId || null,
        customer_id: p.customerId || saleInfo?.customerId || null,
        received_by: admin.id,
        amount: Math.max(0, safeMoney(p.amount)),
        payment_method: String(p.method || "Cash") || "Cash",
        reference_number: p.invoice || saleInfo?.invoice || null,
        notes: p.note || null,
        payment_date: paymentDate,
        currency: paymentCurrency
      });
    }

    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, name: "CATCH STORE SERVER", status: "online", database: "connected", message: "CATCH STORE API is running" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/db-test", async (req, res) => {
  try { const r = await pool.query("SELECT NOW() AS time"); res.json({ success: true, database: "connected", time: r.rows[0].time }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/schema", async (req, res) => {
  try {
    const r = await pool.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`);
    res.json({ success: true, tables: r.rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/bootstrap", async (req, res) => {
  try { res.json({ success: true, data: await bootstrap() }); }
  catch (e) { console.error(e); res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/sync", async (req, res) => {
  try { await syncDB(req.body || {}); res.json({ success: true }); }
  catch (e) { console.error("SYNC ERROR:", e); res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/:table", async (req, res) => {
  const { table } = req.params;
  if (!allowed(table)) return res.status(404).json({ success: false, error: "Table not allowed" });
  try { const r = await pool.query(`SELECT * FROM ${qi(table)} ORDER BY 1 DESC`); res.json({ success: true, data: r.rows }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/:table/:id", async (req, res) => {
  const { table, id } = req.params;
  if (!allowed(table)) return res.status(404).json({ success: false, error: "Table not allowed" });
  try { const r = await pool.query(`SELECT * FROM ${qi(table)} WHERE id=$1 LIMIT 1`, [id]); if (!r.rows[0]) return res.status(404).json({ success:false,error:"Record not found" }); res.json({ success:true,data:r.rows[0] }); }
  catch (e) { res.status(500).json({ success:false,error:e.message }); }
});

app.post("/api/:table", async (req, res) => {
  const { table } = req.params;
  if (!allowed(table)) return res.status(404).json({ success:false,error:"Table not allowed" });
  const body=req.body||{}; const keys=Object.keys(body); if(!keys.length) return res.status(400).json({success:false,error:"No data supplied"});
  try { const vals=keys.map(k=>body[k]); const r=await pool.query(`INSERT INTO ${qi(table)} (${keys.map(qi).join(",")}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *`,vals); res.status(201).json({success:true,data:r.rows[0]}); }
  catch(e){res.status(500).json({success:false,error:e.message});}
});

app.patch("/api/:table/:id", async (req,res)=>{
  const {table,id}=req.params; if(!allowed(table)) return res.status(404).json({success:false,error:"Table not allowed"});
  const keys=Object.keys(req.body||{}); if(!keys.length) return res.status(400).json({success:false,error:"No data supplied"});
  try { const vals=keys.map(k=>req.body[k]); vals.push(id); const set=keys.map((k,i)=>`${qi(k)}=$${i+1}`).join(","); const r=await pool.query(`UPDATE ${qi(table)} SET ${set} WHERE id=$${vals.length} RETURNING *`,vals); if(!r.rows[0]) return res.status(404).json({success:false,error:"Record not found"}); res.json({success:true,data:r.rows[0]}); }
  catch(e){res.status(500).json({success:false,error:e.message});}
});

app.delete("/api/:table/:id", async (req,res)=>{
  const {table,id}=req.params; if(!allowed(table)) return res.status(404).json({success:false,error:"Table not allowed"});
  try { const r=await pool.query(`DELETE FROM ${qi(table)} WHERE id=$1 RETURNING *`,[id]); if(!r.rows[0]) return res.status(404).json({success:false,error:"Record not found"}); res.json({success:true,deleted:r.rows[0]}); }
  catch(e){res.status(500).json({success:false,error:e.message});}
});

app.use("/api",(req,res)=>res.status(404).json({success:false,error:"API endpoint not found"}));

async function start(){
  try {
    await pool.query("SELECT 1");
    console.log("Supabase database connected successfully.");
    app.listen(PORT,"0.0.0.0",()=>{
      console.log("====================================");
      console.log("       CATCH STORE SERVER");
      console.log("====================================");
      console.log(`Server running on port ${PORT}`);
      console.log(`Local: http://localhost:${PORT}`);
      console.log("Cloud sync: ENABLED");
      console.log("====================================");
    });
  } catch(e){ console.error("DATABASE CONNECTION FAILED"); console.error(e.message); process.exit(1); }
}
start();
