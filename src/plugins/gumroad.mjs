// src/plugins/gumroad.mjs
export default async function gumroadPlugin(fastify) {
  const sellerId = process.env.GUMROAD_SELLER_ID;
  const product  = process.env.GUMROAD_PRODUCT_PERMALINK;
  const TOPUP_S  = Number(process.env.PAID_SECONDS_PER_PURCHASE || '1800'); // default 30 min

  const { grantPro, addPaidSeconds } = await import('../lib/license.mjs');

  fastify.post('/billing/gumroad/webhook', async (req, reply) => {
    if (req.headers['content-type'] !== 'application/json') {
      return reply.code(400).send('Invalid content type');
    }
    const body = req.body || {};
    if (body.seller_id !== sellerId) {
      return reply.code(400).send('Invalid seller');
    }
    const userId   = body.url_params?.userId || body.email || body.order_id || 'unknown';
    const license  = body.license_key;
    const qty      = Number(body.quantity || 1);

    await grantPro(userId, license);
    await addPaidSeconds(userId, TOPUP_S * Math.max(1, qty));

    return reply.code(200).send('OK');
  });

  // Optional: server-side license verification if you need it later
  fastify.post('/billing/license/verify', async (req, reply) => {
    try {
      const { userId, license_key } = req.body || {};
      if (!userId || !license_key || !product) {
        return reply.code(400).send({ ok:false, error:'Missing userId|license_key|product' });
      }
      const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method: 'POST',
        headers: { 'Content-Type':'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_permalink: product, license_key })
      });
      const json = await res.json();
      if (json.success) {
        await grantPro(userId, license_key);
        await addPaidSeconds(userId, TOPUP_S);
        return reply.send({ ok:true, purchase: json.purchase });
      }
      return reply.code(402).send({ ok:false, error:'License invalid', details: json });
    } catch (e) {
      return reply.code(500).send({ ok:false, error: e.message });
    }
  });

  // Handy for clients to build the right link with their userId
  fastify.get('/billing/checkout-link', async (req, reply) => {
    const userId = req.query?.userId || 'anonymous';
    if (!product) return reply.code(500).send({ ok:false, error:'GUMROAD_PRODUCT_PERMALINK not set' });
    const url = `https://yitzi.gumroad.com/l/${product}?wanted=true&userId=${encodeURIComponent(userId)}`;
    return reply.send({ ok:true, url });
  });
}
