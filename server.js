
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const admin = require("firebase-admin");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const EVENT = "Bayern vs Ajax";
const FRONTEND_URL = "https://www.talantasportcitytickets.com/";
const PAYSTACK_URL = "https://api.paystack.co";
const PAYHERO_URL = "https://backend.payhero.co.ke";

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

// FIREBASE
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

// CORS - UPDATED FOR TALANTA DOMAINS
const ALLOWED_ORIGINS = [
  "https://talantacity.com",
  "https://www.talantacity.com",
  "https://talantasportcitytickets.com",
  "https://www.talantasportcitytickets.com",
  "https://kisima614.github.io",
  "http://localhost:3000"
];

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

// PAYSTACK AUTHENTICATION
function paymentHeaders() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is missing.");
  }

  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

// PAYHERO AUTHENTICATION
function payheroHeaders() {
  let token = process.env.PAYHERO_BASIC_AUTH_TOKEN;

  if (!token) {
    const username = process.env.PAYHERO_API_USERNAME;
    const password = process.env.PAYHERO_API_PASSWORD;

    if (!username || !password) {
      throw new Error("PayHero API credentials are missing.");
    }

    token = Buffer.from(`${username}:${password}`).toString("base64");
  }

  token = token.replace(/^Basic\s+/i, "").trim();

  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json"
  };
}

// HELPERS
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

function normalizePhone(phone) {
  const value = String(phone || "").replace(/[\s-]/g, "");

  if (/^07\d{8}$/.test(value) || /^01\d{8}$/.test(value)) {
    return "+254" + value.slice(1);
  }

  if (/^\+254[17]\d{8}$/.test(value)) {
    return value;
  }

  if (/^254[17]\d{8}$/.test(value)) {
    return "+" + value;
  }

  throw new Error("Enter a valid Kenyan mobile number.");
}

function validReference(reference) {
  return /^TSC-[a-f0-9-]{36}$/i.test(reference);
}

function seatDocument(seatId) {
  return db.collection("stadiumSeats").doc(seatId);
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
    const counter = counterSnap.exists
      ? counterSnap.data()
      : { sold: 0, held: 0 };

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
          throw new Error(
            "One or more selected seats are already taken. Please choose different seats."
          );
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

// FINALIZE A VERIFIED PAYMENT
async function finalizeBooking(reference, paymentReference) {
  const bookingRef = db.collection("bookings").doc(reference);

  return db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);

    if (!bookingSnap.exists) {
      throw new Error("Booking record not found.");
    }

    const booking = bookingSnap.data();

    if (booking.status === "paid") return booking;

    if (booking.status !== "pending") {
      throw new Error("Booking is no longer pending.");
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
        throw new Error("One or more seat reservations are no longer valid.");
      }
    }

    const now = Timestamp.now();

    tx.set(counterRef, {
      sold: (counter.sold || 0) + booking.quantity,
      held: Math.max(0, (counter.held || 0) - booking.quantity)
    });

    seatSnaps.forEach((snap, index) => {
      tx.update(seatRefs[index], {
        status: "paid",
        paidAt: now,
        paymentReference
      });
    });

    const confirmed = {
      ...booking,
      status: "paid",
      paymentStatus: "success",
      ticketNumber: ticketNumber(),
      paymentReference,
      paidAt: now
    };

    tx.set(bookingRef, confirmed);

    return confirmed;
  });
}

// VERIFY PAYSTACK CARD PAYMENT
async function confirmCardPayment(reference) {
  const bookingSnap = await db.collection("bookings")
    .doc(reference).get();

  if (!bookingSnap.exists) {
    throw new Error("Booking record not found.");
  }

  const booking = bookingSnap.data();

  if (booking.status === "paid") return booking;

  if (
    booking.paymentMethod !== "card" ||
    booking.paymentProvider !== "paystack"
  ) {
    throw new Error("This is not a Paystack card payment.");
  }

  const response = await axios.get(
    `${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: paymentHeaders(), timeout: 20000 }
  );

  const payment = response.data.data;

  if (
    response.data.status !== true ||
    payment.status !== "success" ||
    payment.reference !== reference ||
    payment.currency !== "KES" ||
    Number(payment.amount) !== booking.amount * 100
  ) {
    throw new Error("Paystack card payment verification failed.");
  }

  return finalizeBooking(reference, reference);
}

// VERIFY PAYHERO M-PESA PAYMENT
async function confirmMpesaPayment(reference) {
  const bookingRef = db.collection("bookings").doc(reference);
  const bookingSnap = await bookingRef.get();

  if (!bookingSnap.exists) {
    throw new Error("M-Pesa booking not found.");
  }

  const booking = bookingSnap.data();

  if (booking.status === "paid") return booking;

  if (
    booking.paymentMethod !== "mobile_money" ||
    booking.paymentProvider !== "payhero" ||
    !booking.payheroReference
  ) {
    throw new Error("PayHero payment reference not found.");
  }

  const response = await axios.get(
    `${PAYHERO_URL}/api/v2/transaction-status`,
    {
      params: {
        reference: booking.payheroReference
      },
      headers: payheroHeaders(),
      timeout: 20000
    }
  );

  const payment = response.data;

  if (
    payment.success !== true ||
    String(payment.status).toUpperCase() !== "SUCCESS" ||
    payment.provider !== "m-pesa" ||
    payment.reference !== booking.payheroReference
  ) {
    throw new Error(
      "PayHero has not confirmed this M-Pesa payment."
    );
  }

  return finalizeBooking(
    reference,
    payment.provider_reference ||
    payment.third_party_reference ||
    booking.payheroReference
  );
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
    paymentMethods: ["PayHero M-Pesa", "Paystack Card"],
    manualSeatSelection: true,
    seatsPerSection: SEATS_PER_SECTION
  });
});

// SEAT AVAILABILITY
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

// TICKET AVAILABILITY
app.get("/api/tickets/availability", async (req, res) => {
  try {
    await releaseExpiredReservations();

    const result = {};

    for (const [name, type] of Object.entries(TICKET_TYPES)) {
      const snap = await db.collection("inventory").doc(name).get();

      const data = snap.exists
        ? snap.data()
        : { sold: 0, held: 0 };

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
  let reservationCreated = false;
  let chargeAccepted = false;

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
    const method = String(payment_method || "").toLowerCase();

    if (!type) {
      throw new Error("Invalid ticket category.");
    }

    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof phone !== "string" ||
      phone.length > 20
    ) {
      throw new Error("Please enter valid customer details.");
    }

    const mobileNumber = normalizePhone(phone);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      throw new Error(`Choose between 1 and ${MAX_QUANTITY} tickets.`);
    }

    const level = Number(stadium_level);
    const selectedSection = Number(section);

    const seats = validateSeats(
      level,
      selectedSection,
      selected_seats,
      quantity
    );

    const isCard = ["card", "bank_card"].includes(method);

    const isMobile = [
      "mobile_money",
      "mpesa",
      "m-pesa"
    ].includes(method);

    if (!isCard && !isMobile) {
      throw new Error("Choose M-Pesa or bank card.");
    }

    if (isCard && !process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("Paystack is not configured.");
    }

    if (
      isMobile &&
      !process.env.PAYHERO_CHANNEL_ID
    ) {
      throw new Error("PayHero channel ID is missing.");
    }

    if (isMobile) {
      payheroHeaders();
    }

    await releaseExpiredReservations();

    reference = bookingReference();

    await createReservation({
      reference,
      name: name.trim(),
      email: email.trim(),
      phone: mobileNumber,
      quantity,
      ticketType,
      paymentMethod: isCard ? "card" : "mobile_money",
      level,
      section: selectedSection,
      seats
    });

    reservationCreated = true;

    const amount = type.price * quantity;

    // PAYSTACK CARD PAYMENT
    if (isCard) {
      const callback =
        process.env.CALLBACK_URL ||
        "https://talanta-sport-city-backend.onrender.com/api/payments/verify";

      const response = await axios.post(
        `${PAYSTACK_URL}/transaction/initialize`,
        {
          email: email.trim(),
          amount: amount * 100,
          currency: "KES",
          reference,
          callback_url: callback,
          channels: ["card"],
          metadata: {
            event: EVENT,
            booking_reference: reference,
            customer_name: name.trim(),
            phone: mobileNumber,
            quantity,
            ticket_type: ticketType,
            unit_price: type.price,
            stadium_level: level,
            section: selectedSection,
            selected_seats: seats.map(seat => seat.number)
          }
        },
        {
          headers: paymentHeaders(),
          timeout: 20000
        }
      );

      if (
        response.data.status !== true ||
        !response.data.data.authorization_url
      ) {
        throw new Error("Paystack card initialization failed.");
      }

      chargeAccepted = true;

      await db.collection("bookings").doc(reference).update({
        paymentProvider: "paystack",
        paymentInitiatedAt: Timestamp.now()
      });

      return res.json({
        status: true,
        provider: "paystack",
        payment_method: "card",
        authorization_url: response.data.data.authorization_url,
        reference,
        amount,
        currency: "KES"
      });
    }

    // PAYHERO M-PESA STK PUSH
    const channelId = Number(process.env.PAYHERO_CHANNEL_ID);

    if (!Number.isInteger(channelId) || channelId <= 0) {
      throw new Error("Invalid PayHero channel ID.");
    }

    const callbackUrl =
      process.env.PAYHERO_CALLBACK_URL ||
      "https://talanta-sport-city-backend.onrender.com/api/payments/payhero-callback";

    const response = await axios.post(
      `${PAYHERO_URL}/api/v2/payments`,
      {
        amount,
        phone_number: mobileNumber,
        channel_id: channelId,
        provider: "m-pesa",
        external_reference: reference,
        customer_name: name.trim(),
        callback_url: callbackUrl
      },
      {
        headers: payheroHeaders(),
        timeout: 30000
      }
    );

    const payment = response.data;

    if (
      payment.success !== true ||
      !payment.reference
    ) {
      throw new Error(
        payment.message || "PayHero could not initiate M-Pesa."
      );
    }

    chargeAccepted = true;

    await db.collection("bookings").doc(reference).update({
      paymentProvider: "payhero",
      payheroReference: payment.reference,
      payheroCheckoutRequestID: payment.CheckoutRequestID || null,
      paymentInitiatedAt: Timestamp.now(),
      payheroStatus: payment.status || "QUEUED"
    });

    return res.json({
      status: true,
      provider: "payhero",
      payment_method: "mobile_money",
      message: "Check your phone and enter your M-Pesa PIN.",
      reference,
      amount,
      currency: "KES"
    });

  } catch (error) {
    console.error(
      "Payment initialization error:",
      error.response?.data || error.message
    );

    if (reference && reservationCreated && !chargeAccepted) {
      try {
        await releaseBooking(reference);
      } catch (releaseError) {
        console.error("Reservation release error:", releaseError.message);
      }
    }

    return res.status(400).json({
      status: false,
      message:
        error.response?.data?.message ||
        error.response?.data?.data?.message ||
        error.message ||
        "Unable to start payment.",
      reference: chargeAccepted ? reference : undefined
    });
  }
});

// PAYSTACK CARD RETURN / VERIFICATION
app.get("/api/payments/verify", async (req, res) => {
  try {
    const reference = String(req.query.reference || "");

    if (!validReference(reference)) {
      return res.status(400).send("Invalid booking reference.");
    }

    const booking = await confirmCardPayment(reference);

    const seats = (booking.seats || [])
      .map(seat =>
        `Section ${booking.section}, Seat ${seat.number}`
      )
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
          <p>Raila Odinga International Stadium, Nairobi</p>
          <hr>
          <p>Customer: ${escapeHTML(booking.customerName)}</p>
          <p>Ticket category: ${escapeHTML(booking.ticketType)}</p>
          <p>Level: ${booking.level}</p>
          <p>Section: ${booking.section}</p>
          <p>Tickets: ${booking.quantity}</p>
          <p>Seats:<br>${seats}</p>
          <h2>KSh ${money(booking.amount)}</h2>
          <p>Ticket number:</p>
          <div class="ref">
            <strong>${escapeHTML(booking.ticketNumber)}</strong>
          </div>
          <p>Payment reference: ${escapeHTML(booking.paymentReference)}</p>
          <p>Keep your ticket details for entry.</p>
          <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error(
      "Paystack verification error:",
      error.response?.data || error.message
    );

    res.status(400).send(`
      <h2>Payment not confirmed</h2>
      <p>${escapeHTML(error.message)}</p>
      <p>If you have paid, contact Talanta Sport City before paying again.</p>
      <a href="${escapeHTML(FRONTEND_URL)}">Return to website</a>
    `);
  }
});

// CHECK PAYMENT STATUS FOR WEBSITE
app.get("/api/payments/status/:reference", async (req, res) => {
  try {
    const reference = String(req.params.reference || "");

    if (!validReference(reference)) {
      return res.status(400).json({
        status: false,
        message: "Invalid booking reference."
      });
    }

    const bookingRef = db.collection("bookings").doc(reference);
    const snap = await bookingRef.get();

    if (!snap.exists) {
      return res.status(404).json({
        status: false,
        message: "Booking not found."
      });
    }

    let booking = snap.data();

    if (
      booking.status === "pending" &&
      booking.paymentMethod === "mobile_money" &&
      booking.paymentProvider === "payhero" &&
      booking.payheroReference
    ) {
      try {
        await confirmMpesaPayment(reference);

        const refreshed = await bookingRef.get();
        booking = refreshed.data();

      } catch (error) {
        console.log("PayHero M-Pesa status check:", error.message);
      }
    }

    return res.json({
      status: true,
      paymentStatus: booking.paymentStatus,
      bookingStatus: booking.status,
      ticketNumber: booking.ticketNumber || null,
      paymentMethod: booking.paymentMethod,
      paymentProvider: booking.paymentProvider || null
    });

  } catch (error) {
    console.error("Payment status error:", error.message);

    res.status(500).json({
      status: false,
      message: "Unable to check payment status."
    });
  }
});

// PAYHERO PAYMENT CALLBACK
app.post("/api/payments/payhero-callback", async (req, res) => {
  try {
    const callback = req.body.response || req.body;

    const reference = String(
      callback.ExternalReference || ""
    );

    if (!validReference(reference)) {
      return res.sendStatus(400);
    }

    const bookingRef = db.collection("bookings").doc(reference);
    const snap = await bookingRef.get();

    if (!snap.exists) {
      return res.sendStatus(404);
    }

    const booking = snap.data();

    if (booking.status === "paid") {
      return res.sendStatus(200);
    }

    if (
      booking.paymentProvider !== "payhero" ||
      booking.paymentMethod !== "mobile_money"
    ) {
      return res.sendStatus(400);
    }

    const callbackStatus = String(
      callback.Status || ""
    ).toLowerCase();

    const resultCode = Number(callback.ResultCode);
    const callbackAmount = Number(callback.Amount);

    if (
      callbackStatus !== "success" ||
      resultCode !== 0 ||
      callbackAmount !== booking.amount ||
      !callback.MpesaReceiptNumber
    ) {
      await bookingRef.update({
        payheroLastCallbackStatus: callback.Status || "Unknown",
        payheroLastCallbackDescription: callback.ResultDesc || null,
        payheroCallbackReceivedAt: Timestamp.now()
      });

      return res.sendStatus(200);
    }

    const confirmed = await confirmMpesaPayment(reference);

    if (confirmed.status !== "paid") {
      throw new Error("Payment could not be finalized.");
    }

    await bookingRef.update({
      mpesaReceiptNumber: String(callback.MpesaReceiptNumber),
      payheroCheckoutRequestID:
        callback.CheckoutRequestID ||
        booking.payheroCheckoutRequestID ||
        null,
      payheroConfirmedAt: Timestamp.now(),
      payheroLastCallbackStatus: "Success"
    });

    console.log("PayHero payment confirmed:", reference);

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "PayHero callback error:",
      error.response?.data || error.message
    );

    return res.sendStatus(500);
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
      const paystackReference = req.body.data.reference;

      const bookingSnap = await db.collection("bookings")
        .doc(paystackReference)
        .get();

      if (
        bookingSnap.exists &&
        bookingSnap.data().paymentMethod === "card" &&
        bookingSnap.data().paymentProvider === "paystack"
      ) {
        await confirmCardPayment(paystackReference);

        console.log(
          "Paystack card payment confirmed:",
          paystackReference
        );
      }
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error(
      "Paystack webhook error:",
      error.response?.data || error.message
    );

    return res.sendStatus(500);
  }
});

// SERVER
app.listen(PORT, () => {
  console.log(`Talanta Sport City running on port ${PORT}`);
});
