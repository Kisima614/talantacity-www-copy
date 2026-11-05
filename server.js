const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;
const PRICE = 2500;
const EVENT = "Bayern vs Ajax";

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://kisima614.github.io/ticket-soko/";

const PAYSTACK_URL = "https://api.paystack.co";

app.use(cors({
  origin: [
    "https://kisima614.github.io",
    "http://localhost:3000"
  ]
}));

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

function escapeHTML(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function paymentHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

// HOME / HEALTH CHECK
app.get("/", (req, res) => {
  res.json({
    service: "Talanta Sport City",
    status: "running",
    event: EVENT,
    ticketPrice: PRICE,
    currency: "KES"
  });
});

// INITIALIZE PAYMENT
app.post("/api/payments/initialize", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      quantity
    } = req.body;

    // DEFAULT PAYMENT METHOD IS M-PESA
    const requestedMethod = String(
      req.body.payment_method || "mobile_money"
    ).toLowerCase();

    let paymentChannel;

    if (
      ["card", "bank_card"].includes(requestedMethod)
    ) {
      paymentChannel = "card";
    } else if (
      ["mobile_money", "mpesa", "m-pesa"].includes(requestedMethod)
    ) {
      paymentChannel = "mobile_money";
    } else {
      return res.status(400).json({
        status: false,
        message: "Invalid payment method."
      });
    }

    // VALIDATE BOOKING DETAILS
    if (
      !name ||
      !email ||
      !phone ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20
    ) {
      return res.status(400).json({
        status: false,
        message: "Please enter valid booking details."
      });
    }

    // CHECK PAYSTACK SECRET KEY
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        status: false,
        message: "Payment service is not configured."
      });
    }

    // CALCULATE TOTAL IN KOBO
    const amount = PRICE * quantity * 100;

    const reference =
      "TSC-" + crypto.randomUUID();

    const callback =
      process.env.CALLBACK_URL ||
      "https://talanta-sport-city-backend.onrender.com/api/payments/verify";

    // SEND REQUEST TO PAYSTACK
    const response = await axios.post(
      `${PAYSTACK_URL}/transaction/initialize`,
      {
        email: email,
        amount: amount,
        currency: "KES",
        reference: reference,

        callback_url: callback,

        // M-PESA OR CARD BASED ON CUSTOMER SELECTION
        channels: [paymentChannel],

        metadata: {
          event: EVENT,
          customer_name: name,
          phone: phone,
          quantity: quantity,
          ticket_type: "Regular",
          unit_price: PRICE,
          payment_method: paymentChannel
        }
      },
      {
        headers: paymentHeaders()
      }
    );

    if (!response.data.status) {
      throw new Error("Payment initialization failed.");
    }

    res.json({
      status: true,
      authorization_url:
        response.data.data.authorization_url,
      reference: reference
    });

  } catch (error) {
    console.error(
      "Initialization error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      status: false,
      message: "Unable to start payment. Please try again."
    });
  }
});

// VERIFY PAYMENT
app.get("/api/payments/verify", async (req, res) => {
  try {
    const reference = req.query.reference;

    if (
      !reference ||
      !/^TSC-[a-f0-9-]{36}$/i.test(reference)
    ) {
      return res.status(400).send(
        "Invalid booking reference."
      );
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).send(
        "Payment verification is unavailable."
      );
    }

    const response = await axios.get(
      `${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: paymentHeaders()
      }
    );

    const payment = response.data.data;
    const meta = payment.metadata || {};

    const quantity = Number(meta.quantity);
    const expectedAmount = PRICE * quantity * 100;

    const valid =
      response.data.status === true &&
      payment.status === "success" &&
      payment.reference === reference &&
      payment.currency === "KES" &&
      Number(payment.amount) === expectedAmount &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 20 &&
      meta.event === EVENT &&
      meta.ticket_type === "Regular";

    if (!valid) {
      return res.status(400).send(`
        <h2>Payment not confirmed</h2>
        <p>Your payment could not be verified.</p>
        <p>Please contact Talanta Sport City.</p>
      `);
    }

    const ticketNumber =
      "TSC-" + String(reference).replace(/[^a-zA-Z0-9]/g, "");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport"
          content="width=device-width, initial-scale=1">
        <title>Payment Successful - Talanta Sport City</title>

        <style>
          body {
            font-family: Arial;
            background: #10172b;
            color: white;
            text-align: center;
            padding: 30px 15px;
          }

          .card {
            background: white;
            color: #172033;
            border-radius: 15px;
            padding: 25px;
            max-width: 420px;
            margin: 25px auto;
          }

          h1 {
            color: #13884b;
          }

          .ref {
            background: #eef2f8;
            padding: 12px;
            border-radius: 7px;
            overflow-wrap: anywhere;
          }

          a {
            display: inline-block;
            background: #13884b;
            color: white;
            padding: 13px 20px;
            text-decoration: none;
            border-radius: 7px;
          }
        </style>
      </head>

      <body>
        <div class="card">

          <h1>Payment Successful!</h1>

          <h2>TALANTA SPORT CITY</h2>

          <p>${escapeHTML(EVENT)}</p>

          <p>Talanta Stadium, Nairobi</p>

          <hr>

          <p>
            Customer:
            ${escapeHTML(meta.customer_name)}
          </p>

          <p>Ticket type: Regular</p>

          <p>Number of tickets: ${quantity}</p>

          <h2>
            KSh ${Number(payment.amount / 100).toLocaleString()}
          </h2>

          <p>Booking reference:</p>

          <div class="ref">
            <strong>${escapeHTML(ticketNumber)}</strong>
          </div>

          <p>
            Keep your booking reference for admission enquiries.
          </p>

          <p>
            Admission validation will be handled separately.
          </p>

          <a href="${escapeHTML(FRONTEND_URL)}">
            Return to website
          </a>

        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(
      "Verification error:",
      error.response?.data || error.message
    );

    res.status(500).send(
      "Unable to verify payment. Please contact support."
    );
  }
});

// PAYSTACK WEBHOOK
app.post("/api/payments/webhook", (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers["x-paystack-signature"];

  if (!secret || !signature || !req.rawBody) {
    return res.sendStatus(401);
  }

  const expectedSignature = crypto
    .createHmac("sha512", secret)
    .update(req.rawBody)
    .digest();

  if (!/^[a-f0-9]{128}$/i.test(signature)) {
    return res.sendStatus(401);
  }

  const receivedSignature =
    Buffer.from(signature, "hex");

  if (
    !crypto.timingSafeEqual(
      expectedSignature,
      receivedSignature
    )
  ) {
    return res.sendStatus(401);
  }

  if (req.body.event === "charge.success") {
    console.log(
      "Successful payment notification:",
      req.body.data.reference
    );
  }

  res.sendStatus(200);
});

// START SERVER
app.listen(PORT, () => {
  console.log(
    `Talanta Sport City backend running on port ${PORT}`
  );
});