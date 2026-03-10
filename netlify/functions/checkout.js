// netlify/functions/checkout.js
// POST /api/checkout
// Creates a Stripe Checkout session and returns the URL
// Customer is redirected to Stripe's hosted checkout page

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const STRIPE_SECRET_KEY = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const { size } = await req.json();

    const params = new URLSearchParams({
      "line_items[0][price]": "price_1T9I4HIb8ylLdFuAfFbxSCsS",
      "line_items[0][quantity]": "1",
      "mode": "payment",
      "success_url": "https://legalizeperps.com/success?session_id={CHECKOUT_SESSION_ID}",
      "cancel_url": "https://legalizeperps.com/",
      "shipping_address_collection[allowed_countries][0]": "US",
      "shipping_address_collection[allowed_countries][1]": "CA",
      "shipping_address_collection[allowed_countries][2]": "GB",
      "shipping_address_collection[allowed_countries][3]": "AU",
      "shipping_address_collection[allowed_countries][4]": "DE",
      "shipping_address_collection[allowed_countries][5]": "FR",
      "allow_promotion_codes": "true",
      "metadata[size]": size || "M",
      "custom_text[submit][message]": `Size: ${size || "M"} — Proceeds buy HYPE on Hyperliquid.`,
    });

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await response.json();

    if (session.error) {
      return new Response(JSON.stringify({ error: session.error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

export const config = { path: "/api/checkout" };
