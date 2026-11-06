
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;
const EVENT = "Bayern vs Ajax";
const FRONTEND_URL = "https://www.talantacity.com/";
const PAYSTACK_URL = "https://api.paystack.co";
const RESERVATION_MINUTES = 15;
const MAX_QUANTITY = 20;
const SEATS_PER_SECTION = 60;

const TICKET_TYPES = {
  Regular: { price: 2500, capacity: 50000 },
  VIP: { price: 5000, capacity: 15000 },
  VVIP: { price: 15000, capacity: 5000 }
};

const LEVEL_SECTIONS = {
  1: { first: 101, last: 128 },
  2: { first: 201, last: 220 },
  3: { first: 401, last: 435 }
};

const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  "/etc/secrets/serviceAccountKey.json";

if (!admin.apps.length) {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error("Firebase service account file not found.");
  }

  const serviceAccount = require(SERVICE_ACCOUNT_PATH);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

app.use(cors({
  origin: [
    "https://talantacity.com",
    "https://www.talantacity.com",
    "https://kisima614.github.io",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

function paymentHeaders() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is missing.");
  }

  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function money(value) {
  return Number(value).toLocaleString("en-KE");
}

function bookingReference() {
  return "TSC-" + crypto.randomUUID();
}

function ticketNumber() {
  return "TSC-" +
    crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
}

function validateSeats(level, section, seats, quantity) {
  const levelInfo = LEVEL_SECTIONS[level];

  if (!levelInfo) {
    throw new Error("Please select a valid stadium level.");
  }

  if (
    !Number.isInteger(section) ||
    section < levelInfo.first ||
    section > levelInfo.last
  ) {
    throw new Error("The selected section does not belong to this level.");
  }

  if (
    !Array.isArray(seats) ||
    seats.length !== quantity ||
    seats.some(seat =>
      !Number.isInteger(seat) ||
      seat < 1 ||
      seat > SEATS_PER_SECTION
    ) ||
    new Set(seats).size !== seats.length
  ) {
    throw new Error("Select the exact number of valid, different seats.");
  }

  return seats.map(seat => ({
    number: seat,
    id: `L${level}-S${section}-N${String(seat).padStart(2, "0")}`
  }));
}

function seatDocument(seatId) {
  return db.collection("stadiumSeats").doc(seatId);
}

// RELEASE ONE EXPIRED BOOKING
async function releaseBooking(reference) {
  const bookingRef = db.collection("bookings").doc(reference);

  await db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) return;

    const booking = bookingSnap.data();

    if (booking.status !== "pending") return;

    const counterRef = db.collection("inventory")
      .doc(booking.ticketType);

    const counterSnap = await tx.get(counterRef);
    const counter = counterSnap.exists ? counterSnap.data() : {};

    const seatRefs = (booking.seats || []).map(seat =>
      seatDocument(seat.id)
    );

    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    tx.set(counterRef, {
      sold: counter.sold || 0,
      held: Math.max(0, (counter.held || 0) - booking.quantity)
    });

    seatSnaps.forEach((snap, index) => {
      if (
        snap.exists &&
        snap.data().reference === reference &&
        snap.data().status === "pending"
      ) {
        tx.delete(seatRefs[index]);
      }
    });

    tx.update(bookingRef, {
      status: "expired",
      paymentStatus: "expired",
      expiredAt: Timestamp.now()
    });
  });
}

// RELEASE EXPIRED RESERVATIONS
async function releaseExpiredReservations() {
  const now = Timestamp.now();

  const expired = await db.collection("bookings")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .limit(50)
    .get();

  for (const doc of expired.docs) {
    await releaseBooking(doc.id);
  }
}

// CREATE EXACT SEAT RESERVATION
async function createReservation(details) {
  const {
    reference,
    name,
    email,
    phone,
    quantity,
    ticketType,
    level,
    section,
    seats,
    paymentMethod
  } = details;

  const type = TICKET_TYPES[ticketType];

  const bookingRef = db.collection("bookings").doc(reference);
  const counterRef = db.collection("inventory").doc(ticketType);

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (bookingSnap.exists) {
      throw new Error("Booking reference already exists.");
    }

    const counterSnap = await tx.get(counterRef);
    const counter = counterSnap.exists ? counterSnap.data() : {
      sold: 0,
      held: 0
    };

    if (
      (counter.sold || 0) +
      (counter.held || 0) +
      quantity > type.capacity
    ) {
      throw new Error("This ticket category has insufficient availability.");
    }

    const seatRefs = seats.map(seat => seatDocument(seat.id));
    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    for (const snap of seatSnaps) {
      if (snap.exists) {
        const existing = snap.data();

        if (
          existing.status === "paid" ||
          (
            existing.status === "pending" &&
            existing.expiresAt &&
            existing.expiresAt.toMillis() > Date.now()
          )
        ) {
          throw new Error("One or more selected seats are already taken. Please choose different seats.");
        }
      }
    }

    const expiresAt = Timestamp.fromDate(
      new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000)
    );

    tx.set(counterRef, {
      sold: counter.sold || 0,
      held: (counter.held || 0) + quantity
    });

    seats.forEach((seat, index) => {
      tx.set(seatRefs[index], {
        seatId: seat.id,
        level,
        section,
        seatNumber: seat.number,
        ticketType,
        reference,
        status: "pending",
        expiresAt,
        createdAt: Timestamp.now()
      });
    });

    tx.create(bookingRef, {
      reference,
      event: EVENT,
      customerName: name,
      email,
      phone,
      ticketType,
      unitPrice: type.price,
      quantity,
      amount: type.price * quantity,
      currency: "KES",
      level,
      section,
      seats,
      status: "pending",
      paymentStatus: "pending",
      paymentMethod,
      createdAt: Timestamp.now(),
      expiresAt
    });

    return { seats, expiresAt };
  });
}

// VERIFY PAYMENT AND CONFIRM EXACT SEATS
async function confirmPayment(reference) {
  const response = await axios.get(
    `${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: paymentHeaders() }
  );

  const payment = response.data.data;
  const meta = payment.metadata || {};
  const type = TICKET_TYPES[meta.ticket_type];

  if (!type) {
    throw new Error("Invalid ticket category.");
  }

  const quantity = Number(meta.quantity);
  const expectedAmount = type.price * quantity * 100;

  const valid =
    response.data.status === true &&
    payment.status === "success" &&
    payment.reference === reference &&
    payment.currency === "KES" &&
    Number(payment.amount) === expectedAmount &&
    meta.event === EVENT &&
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_QUANTITY;

  if (!valid) {
    throw new Error("Paystack payment verification failed.");
  }

  const bookingRef = db.collection("bookings").doc(reference);

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) {
      throw new Error("Booking record not found.");
    }

    const booking = bookingSnap.data();

    if (booking.status === "paid") {
      return booking;
    }

    if (
      booking.status !== "pending" ||
      booking.ticketType !== meta.ticket_type ||
      booking.quantity !== quantity ||
      booking.amount * 100 !== Number(payment.amount)
    ) {
      throw new Error("Booking cannot be confirmed. Contact support before paying again.");
    }

    const counterRef = db.collection("inventory")
      .doc(booking.ticketType);

    const counterSnap = await tx.get(counterRef);
    const counter = counterSnap.exists ? counterSnap.data() : {};

    const seatRefs = (booking.seats || []).map(seat =>
      seatDocument(seat.id)
    );

    const seatSnaps = [];

    for (const ref of seatRefs) {
      seatSnaps.push(await tx.get(ref));
    }

    for (const snap of seatSnaps) {
      if (
        !snap.exists ||
        snap.data().reference !== reference ||
        snap.data().status !== "pending"
      ) {
        throw new Error("One or more seat reservations are no longer valid. Contact support.");
      }
    }

    const now = Timestamp.now();

    tx.set(counterRef, {
      sold: (counter.sold || 0) + quantity,
      held: Math.max(0, (counter.held || 0) - quantity)
    });

    seatSnaps.forEach((snap, index) => {
      tx.update(seatRefs[index], {
        status: "paid",
        paidAt: now,
        paymentReference: reference
      });
    });

    const confirmed = {
      ...booking,
      status: "paid",
      paymentStatus: "success",
      ticketNumber: ticketNumber(),
      paymentReference: reference,
      paidAt: now
    };

    tx.set(bookingRef, confirmed);

    return confirmed;
  });
}

// HOME
app.get("/", (req, res) => {
  res.json({
    service: "Talanta Sport City",
    status: "running",
    event: EVENT,
    capacity: 70000,
    categories: TICKET_TYPES,
    currency: "KES",
    manualSeatSelection: true,
    seatsPerSection: SEATS_PER_SECTION
  });
});

// GET SECTION SEAT AVAILABILITY
app.get("/api/seats/:level/:section", async (req, res) => {
  try {
    const level = Number(req.params.level);
    const section = Number(req.params.section);
    const levelInfo = LEVEL_SECTIONS[level];

    if (
      !levelInfo ||
      !Number.isInteger(section) ||
      section < levelInfo.first ||
      section > levelInfo.last
    ) {
      return res.status(400).json({
        status: false,
        message: "Invalid level or section."
      });
    }

    await releaseExpiredReservations();

    const result = [];

    for (let number = 1; number <= SEATS_PER_SECTION; number++) {
      const id = `L${level}-S${section}-N${String(number).padStart(2, "0")}`;
      const snap = await seatDocument(id).get();

      let status = "available";

      if (snap.exists) {
        const data = snap.data();

        if (data.status === "paid") {
          status = "sold";
        } else if (
          data.status === "pending" &&
          data.expiresAt &&
          data.expiresAt.toMillis() > Date.now()
        ) {
          status = "reserved";
        }
      }

      result.push({ number, id, status });
    }

    res.json({
      status: true,
      level,
      section,
      seats: result
    });

  } catch (error) {
    console.error("Seat availability error:", error.message);
    res.status(500).json({
      status: false,
      message: "Unable to retrieve seat availability."
    });
  }
});

// TICKET CATEGORY AVAILABILITY
app.get("/api/tickets/availability", async (req, res) => {
  try {
    await releaseExpiredReservations();

    const result = {};

    for (const [name, type] of Object.entries(TICKET_TYPES)) {
      const snap = await db.collection("inventory").doc(name).get();
      const data = snap.exists ? snap.data() : {
        sold: 0,
        held: 0
      };

      result[name] = {
        capacity: type.capacity,
        sold: data.sold || 0,
        reserved: data.held || 0,
        available: Math.max(
          0,
          type.capacity - (data.sold || 0) - (data.held || 0)
        ),
        price: type.price
      };
    }

    res.json({ status: true, availability: result });

  } catch (error) {
    console.error("Availability error:", error.message);
    res.status(500).json({
      status: false,
      message: "Unable to retrieve ticket availability."
    });
  }
});

// INITIALIZE PAYMENT
app.post("/api/payments/initialize", async (req, res) => {
  let reference;

  try {
    const {
      name,
      email,
      phone,
      quantity,
      ticket_type,
      payment_method,
      stadium_level,
      section,
      selected_seats
    } = req.body;

    const ticketType = String(ticket_type || "");
    const type = TICKET_TYPES[ticketType];
    const method = String(payment_method || "mobile_money").toLowerCase();

    if (!type) {
      return res.status(400).json({
        status: false,
        message: "Invalid ticket category."
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
      quantity > MAX_QUANTITY
    ) {
      return res.status(400).json({
        status: false,
        message: `Choose between 1 and ${MAX_QUANTITY} tickets.`
      });
    }

    const level = Number(stadium_level);
    const selectedSection = Number(section);

    const seats = validateSeats(
      level,
      selectedSection,
      selected_seats,
      quantity
    );

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

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        status: false,
        message: "Payment service is not configured."
      });
    }

    await releaseExpiredReservations();

    reference = bookingReference();

    const reservation = await createReservation({
      reference,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      quantity,
      ticketType,
      paymentMethod: channel,
      level,
      section: selectedSection,
      seats
    });

    try {
      const callback =
        process.env.CALLBACK_URL ||
        "https://talanta-sport-city-backend.onrender.com/api/payments/verify";

      const response = await axios.post(
        `${PAYSTACK_URL}/transaction/initialize`,
        {
          email: email.trim(),
          amount: type.price * quantity * 100,
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
            unit_price: type.price,
            stadium_level: level,
            section: selectedSection,
            selected_seats: seats.map(seat => seat.number)
          }
        },
        { headers: paymentHeaders() }
      );

      if (
        !response.data.status ||
        !response.data.data.authorization_url
      ) {
        throw new Error("Paystack initialization failed.");
      }

      res.json({
        status: true,
        authorization_url: response.data.data.authorization_url,
        reference,
        level,
        section: selectedSection,
        seats,
        expires_in_minutes: RESERVATION_MINUTES,
        amount: type.price * quantity,
        currency: "KES"
      });

    } catch (error) {
      await releaseBooking(reference);
      throw error;
    }

  } catch (error) {
    console.error(
      "Payment initialization error:",
      error.response?.data || error.message
    );

    res.status(400).json({
      status: false,
      message: error.message || "Unable to start payment."
    });
  }
});

// PAYMENT VERIFICATION CALLBACK
app.get("/api/payments/verify", async (req, res) => {
  try {
    const reference = String(req.query.reference || "");

    if (!/^TSC-[a-f0-9-]{36}$/i.test(reference)) {
      return res.status(400).send("Invalid booking reference.");
    }

    const booking = await confirmPayment(reference);
    const seats = (booking.seats || [])
      .map(seat => `Section ${booking.section}, Seat ${seat.number}`)
      .map(escapeHTML)
      .join("<br>");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Payment Successful | Talanta Sport City</title>
        <style>
          body {
            font-family:Arial,sans-serif;
            background:#10172b;
            color:white;
            text-align:center;
            padding:25px 12px;
          }
          .card {
            background:white;
            color:#172033;
            max-width:430px;
            margin:20px auto;
            padding:25px;
            border-radius:13px;
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
          <p>Customer: ${escapeHTML(booking.customerName)}</p>
          <p>Ticket category: ${escapeHTML(booking.ticketType)}</p>
          <p>Level: ${booking.level}</p>
          <p>Section: ${booking.section}</p>
          <p>Tickets: ${booking.quantity}</p>
          <p>Seats:<br>${seats}</p>
          <h2>KSh ${money(booking.amount)}</h2>
          <p>Ticket number:</p>
          <div class="ref"><strong>${escapeHTML(booking.ticketNumber)}</strong></div>
          <p>Payment reference: ${escapeHTML(reference)}</p>
          <p>Keep your ticket details for entry.</p>
          <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("Verification error:", error.response?.data || error.message);

    res.status(400).send(`
      <h2>Payment not confirmed</h2>
      <p>${escapeHTML(error.message)}</p>
      <p>If you have paid, contact Talanta Sport City before paying again.</p>
    `);
  }
});

// PAYSTACK WEBHOOK
app.post("/api/payments/webhook", async (req, res) => {
  try {
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
      const reference = req.body.data.reference;
      await confirmPayment(reference);
      console.log("Confirmed payment:", reference);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Talanta Sport City running on port ${PORT}`);
});
