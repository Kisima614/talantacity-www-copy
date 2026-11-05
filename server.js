
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;
const EVENT = "Bayern vs Ajax";

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "https://kisima614.github.io/ticket-soko/";

const PAYSTACK_URL = "https://api.paystack.co";

const TICKET_PRICES = {
  Regular: 2500,
  VIP: 5000,
  VVIP: 15000
};

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
    Authorization:
      `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

// HOME
app.get("/", (req, res) => {
  res.json({
    service: "Talanta Sport City",
    status: "running",
    event: EVENT,
    prices: TICKET_PRICES,
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
      quantity,
      ticket_type,
      section,
      selected_seats,
      stadium_level
    } = req.body;

    const method = String(
      req.body.payment_method || "mobile_money"
    ).toLowerCase();

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        status: false,
        message: "Payment service is not configured."
      });
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof phone !== "string" ||
      !phone.trim() ||
      phone.length > 20
    ) {
      return res.status(400).json({
        status: false,
        message: "Please enter valid customer details."
      });
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20
    ) {
      return res.status(400).json({
        status: false,
        message: "Choose between 1 and 20 tickets."
      });
    }

    const ticketType = String(ticket_type || "");

    if (!Object.prototype.hasOwnProperty.call(
      TICKET_PRICES,
      ticketType
    )) {
      return res.status(400).json({
        status: false,
        message: "Invalid ticket category."
      });
    }

    const unitPrice = TICKET_PRICES[ticketType];
    const amount = unitPrice * quantity * 100;

    if (
      !Array.isArray(selected_seats) ||
      selected_seats.length !== quantity ||
      selected_seats.some(
        seat => !Number.isInteger(seat) ||
        seat < 1 || seat > 60
      )
    ) {
      return res.status(400).json({
        status: false,
        message: "Please select the correct number of seats."
      });
    }

    if (
      !Number.isInteger(Number(section)) ||
      Number(section) < 1
    ) {
      return res.status(400).json({
        status: false,
        message: "Please select a seating section."
      });
    }

    if (
      ![1, 2, 3].includes(Number(stadium_level))
    ) {
      return res.status(400).json({
        status: false,
        message: "Invalid stadium level."
      });
    }

    let channel;

    if (["card", "bank_card"].includes(method)) {
      channel = "card";
    } else if (
      ["mobile_money", "mpesa", "m-pesa"].includes(method)
    ) {
      channel = "mobile_money";
    } else {
      return res.status(400).json({
        status: false,
        message: "Invalid payment method."
      });
    }

    const reference = "TSC-" + crypto.randomUUID();

    const callback =
      process.env.CALLBACK_URL ||
      "https://talanta-sport-city-backend.onrender.com/api/payments/verify";

    const response = await axios.post(
      `${PAYSTACK_URL}/transaction/initialize`,
      {
        email: email.trim(),
        amount,
        currency: "KES",
        reference,
        callback_url: callback,
        channels: [channel],

        metadata: {
          event: EVENT,
          customer_name: name.trim(),
          phone: phone.trim(),
          quantity,
          ticket_type: ticketType,
          unit_price: unitPrice,
          section: Number(section),
          stadium_level: Number(stadium_level),
          selected_seats,
          payment_method: channel
        }
      },
      {
        headers: paymentHeaders()
      }
    );

    if (
      !response.data.status ||
      !response.data.data.authorization_url
    ) {
      throw new Error("Paystack initialization failed.");
    }

    res.json({
      status: true,
      authorization_url:
        response.data.data.authorization_url,
      reference,
      amount: unitPrice * quantity,
      currency: "KES"
    });

  } catch (error) {
    console.error(
      "Payment initialization error:",
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
      return res.status(400).send("Invalid booking reference.");
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
    const ticketType = String(meta.ticket_type || "");
    const unitPrice = TICKET_PRICES[ticketType];

    if (
      !unitPrice ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20
    ) {
      return res.status(400).send("Invalid ticket information.");
    }

    const expectedAmount = unitPrice * quantity * 100;

    const valid =
      response.data.status === true &&
      payment.status === "success" &&
      payment.reference === reference &&
      payment.currency === "KES" &&
      Number(payment.amount) === expectedAmount &&
      meta.event === EVENT &&
      Number(meta.unit_price) === unitPrice &&
      Array.isArray(meta.selected_seats) &&
      meta.selected_seats.length === quantity;

    if (!valid) {
      return res.status(400).send(`
        <h2>Payment not confirmed</h2>
        <p>Your payment could not be verified.</p>
        <p>Please contact Talanta Sport City.</p>
      `);
    }

    const ticketNumber =
      "TSC-" + crypto.randomUUID().slice(0, 12).toUpperCase();

    const total = unitPrice * quantity;

    const seats = meta.selected_seats
      .map(escapeHTML)
      .join(", ");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Payment Successful | Talanta Sport City</title>
        <style>
          body {
            font-family: Arial;
            background: #10172b;
            color: white;
            text-align: center;
            padding: 25px 12px;
          }
          .card {
            background: white;
            color: #172033;
            max-width: 430px;
            margin: 20px auto;
            padding: 25px;
            border-radius: 13px;
          }
          h1 {color:#13884b}
          .ref {
            background:#eef2f8;
            padding:13px;
            overflow-wrap:anywhere;
          }
          a {
            display:inline-block;
            background:#13884b;
            color:white;
            padding:13px 22px;
            text-decoration:none;
            border-radius:6px;
            margin-top:15px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>✓ Payment Successful!</h1>
          <h2>TALANTA SPORT CITY</h2>
          <h3>${escapeHTML(EVENT)}</h3>
          <p>Talanta Stadium, Nairobi</p>
          <hr>
          <p>Customer: ${escapeHTML(meta.customer_name)}</p>
          <p>Ticket category: ${escapeHTML(ticketType)}</p>
          <p>Tickets: ${quantity}</p>
          <p>Level: ${escapeHTML(meta.stadium_level)}</p>
          <p>Section: ${escapeHTML(meta.section)}</p>
          <p>Seats: ${seats}</p>
          <h2>${escapeHTML(total.toLocaleString("en-KE"))} KSh</h2>
          <p>Booking reference:</p>
          <div class="ref"><strong>${escapeHTML(ticketNumber)}</strong></div>
          <p>Payment reference: ${escapeHTML(reference)}</p>
          <p>Keep this reference for booking enquiries.</p>
          <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
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

  const expected = crypto
    .createHmac("sha512", secret)
    .update(req.rawBody)
    .digest();

  if (!/^[a-f0-9]{128}$/i.test(signature)) {
    return res.sendStatus(401);
  }

  const received = Buffer.from(signature, "hex");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.sendStatus(401);
  }

  if (req.body.event === "charge.success") {
    console.log(
      "Successful Paystack payment:",
      req.body.data.reference
    );
  }

  res.sendStatus(200);
});

// START SERVER
app.listen(PORT, () => {
  console.log(
    `Talanta Sport City running on port ${PORT}`
  );
});
