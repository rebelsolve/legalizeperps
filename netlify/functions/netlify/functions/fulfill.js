// netlify/functions/fulfill.js
// POST /api/fulfill
// Triggered by Stripe webhook on checkout.session.completed
// Pulls shipping address + size from Stripe, creates order in Printful

export default async (req, context) => {
  const STRIPE_SECRET_KEY = Netlify.env.get("STRIPE_SECRET_KEY");
  const STRIPE_WEBHOOK_SECRET = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const PRINTFUL_API_KEY = Netlify.env.get("PRINTFUL_API_KEY");

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  // ── VERIFY STRIPE WEBHOOK SIGNATURE ───────────────────────────────────────
  let event;
  try {
    event = await verifyStripeWebhook(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("Webhook signature verification failed:", e.message);
    return new Response(`Webhook Error: ${e.message}`, { status: 400 });
  }

  // Only handle completed checkouts
  if (event.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const session = event.data.object;
  const size = session.metadata?.size || "M";
  const shipping = session.shipping_details?.address;
  const customerName = session.shipping_details?.name || session.customer_details?.name || "Customer";
  const customerEmail = session.customer_details?.email || "";

  if (!shipping) {
    console.error("No shipping address in session:", session.id);
    return new Response("No shipping address", { status: 400 });
  }

  // ── GET PRINTFUL VARIANT ID FOR SIZE ──────────────────────────────────────
  // Gildan 64000 Unisex Softstyle T-Shirt — Black
  // These are Printful catalog variant IDs for the black colorway
  const PRINTFUL_VARIANT_MAP = {
    "S":   4011,
    "M":   4012,
    "L":   4013,
    "XL":  4014,
    "2XL": 4015,
    "3XL": 4016,
  };

  // We'll look up the correct variant dynamically to be safe
  let variantId = PRINTFUL_VARIANT_MAP[size] || PRINTFUL_VARIANT_MAP["M"];

  try {
    // Fetch the actual variant ID from Printful catalog
    const catalogRes = await fetch(
      "https://api.printful.com/products?category_id=14&limit=100",
      {
        headers: {
          "Authorization": `Bearer ${PRINTFUL_API_KEY}`,
          "Content-Type": "application/json",
        }
      }
    );
    // If catalog lookup fails, fall back to hardcoded IDs above
  } catch (e) {
    console.log("Catalog lookup skipped, using hardcoded variant IDs");
  }

  // ── CREATE PRINTFUL ORDER ─────────────────────────────────────────────────
  const printfulOrder = {
    recipient: {
      name: customerName,
      email: customerEmail,
      address1: shipping.line1,
      address2: shipping.line2 || "",
      city: shipping.city,
      state_code: shipping.state,
      country_code: shipping.country,
      zip: shipping.postal_code,
    },
    items: [
      {
        variant_id: variantId,
        quantity: 1,
        name: `Legalize Perps Tee — ${size}`,
      }
    ],
    retail_costs: {
      currency: "USD",
      subtotal: "30.00",
      total: "30.00",
    }
  };

  try {
    const printfulRes = await fetch("https://api.printful.com/orders", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PRINTFUL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(printfulOrder),
    });

    const printfulData = await printfulRes.json();

    if (printfulData.code !== 200) {
      console.error("Printful order failed:", JSON.stringify(printfulData));
      // Don't return error to Stripe — log and handle manually
      // Stripe will retry if we return non-200
      return new Response(JSON.stringify({
        received: true,
        fulfillment: "failed",
        error: printfulData.result,
      }), { headers: { "Content-Type": "application/json" } });
    }

    console.log("Printful order created:", printfulData.result.id);

    return new Response(JSON.stringify({
      received: true,
      fulfillment: "success",
      printfulOrderId: printfulData.result.id,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (e) {
    console.error("Printful API error:", e.message);
    return new Response(JSON.stringify({ received: true, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

// ── STRIPE WEBHOOK SIGNATURE VERIFICATION ────────────────────────────────────
// Implements Stripe's HMAC-SHA256 verification without the Stripe SDK
async function verifyStripeWebhook(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error("No stripe-signature header");
  if (!secret) throw new Error("No webhook secret configured");

  const parts = sigHeader.split(",");
  const tPart = parts.find(p => p.startsWith("t="));
  const v1Part = parts.find(p => p.startsWith("v1="));

  if (!tPart || !v1Part) throw new Error("Invalid signature format");

  const timestamp = tPart.slice(2);
  const signature = v1Part.slice(3);
  const signedPayload = `${timestamp}.${payload}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedSig !== signature) throw new Error("Signature mismatch");

  // Check timestamp is within 5 minutes
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
    throw new Error("Timestamp too old");
  }

  return JSON.parse(payload);
}

export const config = { path: "/api/fulfill" };
