# 🚛 Dock Management System – Node.js + Express + MongoDB + Socket.IO

A real-time dock assignment and management system built with Node.js, Express, MongoDB, and Socket.IO. It supports dynamic dock assignment based on vehicle type and route timing, with real-time updates via sockets and CSV-based configuration for routes.

---

## 📦 Features

- 📌 Assign docks to vehicles dynamically
- 📋 Prioritize waiting vehicles based on route and promise times
- 🛑 Enable/disable docks as needed
- ⏱️ Automatically assign waiting vehicles when docks become free
- 💾 Store dock activity (in/out) in MongoDB
- 📡 Real-time status updates with Socket.IO
- 📈 CSV-based route master integration

---

## 🔧 Tech Stack

- **Backend**: Node.js, Express
- **Database**: MongoDB
- **Realtime**: Socket.IO
- **CSV Parsing**: `csv-parser`
- **Time Handling**: `moment`, `luxon`
- **Environment Configuration**: `dotenv`

---

## 📁 Project Structure

```
📦 project-root/
├── dock-in-promise-updated.csv       # Route master data
├── .env                              # Environment variables
├── server.js                         # Main application file
├── package.json
└── README.md                         # This file
```

---

## 📄 Environment Variables

Create a `.env` file in the root directory:

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
```

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/Dibyendu-13/Dock-Management-Backend.git
cd Dock-Management-Backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Add Route Master CSV

Place your `dock-in-promise-updated.csv` in the project root. It should include fields like:

```
SMH,dock in time,Promise
PH,07:00 AM,08:30 AM
GGN,08:30 AM,10:30 AM
FRK,09:00 AM,11:00 AM
...
```

### 4. Run the server

```bash
node server.js
```

---

## 📡 API Endpoints

### `POST /api/assign-dock`
Assigns a dock to a vehicle or adds it to a waiting list.

#### Body
```json
{
  "vehicleNumber": "XYZ123",
  "source": "PH",
  "unloadingTime": "30",
  "is3PL": false
}
```

---

### `POST /api/release-dock`
Releases a dock and updates dock-out time in DB.

#### Body
```json
{
  "dockId": "XYZ123-2"
}
```

---

### `GET /api/dock-status`
Returns the current dock and waiting vehicle status.

---

### `POST /api/initialize-docks`
Resets all docks to available and clears the waiting list.

---

### `POST /api/disable-dock`
Disables a specific dock.

#### Body
```json
{
  "dockNumber": 3
}
```

---

### `POST /api/enable-dock`
Enables a disabled dock.

#### Body
```json
{
  "dock": {
    "dockNumber": 3,
    "id": 3,
    ...
  }
}
```

---

## 🔄 Real-Time Updates

Clients can listen for real-time updates on dock status via Socket.IO:

```js
const socket = io('http://localhost:5000');
socket.on('dockStatusUpdate', ({ docks, waitingVehicles }) => {
  console.log(docks, waitingVehicles);
});
```

---

## 🧠 Logic Highlights

- Vehicles from **FRK** and **GGN** are prioritized.
- For **PH**, multiple vehicles may be assigned to the same dock.
- 3PL vehicles are assigned to docks 7-9.
- If all docks are full, vehicles are pushed to a **waiting list** and automatically assigned as docks free up.
- The app uses a **CSV file** for dock-in times and promise times.

---

## 📅 Automatic Dock Assignment

Every 60 seconds, the app attempts to assign waiting vehicles to available docks using:

```js
setInterval(assignWaitingVehiclesToDocks, 60000);
```

---

## 🧪 Sample Test Flow

1. POST to `/api/assign-dock` with a new vehicle.
2. View dock assignment via `GET /api/dock-status`.
3. Release a dock via `POST /api/release-dock`.
4. Watch reassignment in real-time via Socket.IO client.

---

## 🛠️ Future Improvements

- Add authentication
- UI dashboard
- Admin panel for manual overrides
- Export dock data to CSV or reports

---

## 👨‍💻 Author

Built with ❤️ by [Your Name or GitHub Handle].
