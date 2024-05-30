const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://dock-mgmt.netlify.app',
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(cors());

let docks = Array.from({ length: 10 }, (_, i) => ({
  dockNumber: i + 1,
  status: 'available',
  vehicleNumber: null,
  source: null,
  unloadingTime: null,
  is3PL: null,
  isDisabled: false, // Added isDisabled property
  id: i + 1,
}));

let waitingVehicles = [];

// Read route master data from CSV file
const routeMaster = [];
fs.createReadStream(path.join(__dirname, 'dock-in-promise-updated.csv'))
  .pipe(csv())
  .on('data', (row) => {
    routeMaster.push(row);
  })
  .on('end', () => {
    // Start the server after reading CSV data
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  });


 
function timeToMinutes(time) {
  const [timePart, period] = time.split(' ');
  let [hours, minutes, seconds] = timePart.split(':');
  hours = parseInt(hours, 10);
  minutes = parseInt(minutes, 10);
  seconds = parseInt(seconds, 10);

  if (period === 'PM' && hours !== 12) {
    hours += 12;
  } else if (period === 'AM' && hours === 12) {
    hours = 0;
  }

  return hours * 60 + minutes + seconds / 60;
}

function getCurrentTimeInMinutes() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  return hours * 60 + minutes + seconds / 60;
}

function compareTimes(source, currentTime) {
  const route = routeMaster.find(r => r.SMH === source);
  if (!route) return true; // If source not in route master, assign dock immediately

  const dockInMinutes = timeToMinutes(route['dock in time']);
  const arrivalMinutes = getCurrentTimeInMinutes();

  return arrivalMinutes <= dockInMinutes;
}

// Function to assign a dock without prioritizing waiting list
function assignDock({ vehicleNumber, source, unloadingTime, is3PL }) {
  let availableDock = null;
  
  if (is3PL) {
    // If the vehicle is 3PL, find an available dock among docks 7, 8, and 9
    availableDock = docks.find(dock => dock.dockNumber >= 7 && dock.dockNumber <= 9 && dock.status === 'available' && !dock.isDisabled);
  } else {
    // For non-3PL vehicles, find any available dock
    availableDock = docks.find(dock => dock.status === 'available' && !dock.isDisabled);
  }
  
  if (availableDock) {
    availableDock.id=`${vehicleNumber}-${availableDock.dockNumber}`
    availableDock.status = 'occupied';
    availableDock.vehicleNumber = vehicleNumber;
    availableDock.source = source;
    availableDock.unloadingTime = unloadingTime;
    availableDock.is3PL = is3PL;
    return availableDock.dockNumber;
  }
  assignWaitingVehiclesToDocks();
  return null;
}


function prioritizeDocks() {
  const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });

  docks.sort((a, b) => {
    const isFRKorGGN_A = a.source === 'FRK' || a.source === 'GGN';
    const isFRKorGGN_B = b.source === 'FRK' || b.source === 'GGN';
    if (isFRKorGGN_A && !isFRKorGGN_B) {
      return -1;
    }
    if (!isFRKorGGN_A && isFRKorGGN_B) {
      return 1;
    }

    const routeA = routeMaster.find(r => r.SMH === a.source);
    const routeB = routeMaster.find(r => r.SMH === b.source);

    if (!routeA || !routeB) {
      return 0;
    }

    const aLateness = timeToMinutes(currentTime) - timeToMinutes(routeA['dock in time']);
    const bLateness = timeToMinutes(currentTime) - timeToMinutes(routeB['dock in time']);

    if (aLateness !== bLateness) {
      return aLateness - bLateness;
    }

    const aPromiseTime = timeToMinutes(routeA.Promise) - 120; // 2 hours before promise time
    const bPromiseTime = timeToMinutes(routeB.Promise) - 120; // 2 hours before promise time

    return aPromiseTime - bPromiseTime;
  });
}



function prioritizeWaitingVehicles() {
  waitingVehicles.sort((a, b) => {
    const aOnTime = compareTimes(a.source, a.currentTime);
    const bOnTime = compareTimes(b.source, b.currentTime);

    if (aOnTime !== bOnTime) {
      return aOnTime - bOnTime;
    }

    const aPromiseTime = timeToMinutes(routeMaster.find(r => r.SMH === a.source).Promise);
    const bPromiseTime = timeToMinutes(routeMaster.find(r => r.SMH === b.source).Promise);
    return aPromiseTime - bPromiseTime;
  });

}




app.post('/api/assign-dock', (req, res) => {
  const { vehicleNumber, source, unloadingTime, is3PL } = req.body;

  let assignedDockNumber = null;

  // Check if there is an available dock
  if (docks.some(dock => dock.status === 'available' && !dock.isDisabled)) {
    assignedDockNumber = assignDock({ vehicleNumber, source, unloadingTime, is3PL });
  }

  console.log(`Assigned Dock Number: ${assignedDockNumber}`);
  if (assignedDockNumber !== null) {
    console.log('Control reaches here: Dock assigned');
    prioritizeDocks();
    io.emit('dockStatusUpdate', { docks, waitingVehicles });
    return res.status(200).json({ message: `Dock ${assignedDockNumber} assigned to vehicle ${vehicleNumber}` });
  }

  console.log('I am here: No available dock, adding vehicle to waiting list');

  // If no available dock, add the vehicle to the waiting list
  waitingVehicles.push({ vehicleNumber, source, unloadingTime, is3PL });

  // Try to assign waiting vehicles to available docks
  assignWaitingVehiclesToDocks();
  prioritizeWaitingVehicles();

  io.emit('dockStatusUpdate', { docks, waitingVehicles });

  // If the vehicle couldn't be assigned immediately, it means all docks are currently occupied
  return res.status(200).json({ message: 'All docks are full or the vehicle is late, added to waiting list' });
});

function assignWaitingVehiclesToDocks() {
  // Iterate through the docks to find available ones
  const availableDocks = docks.filter(dock => dock.status === 'available' && !dock.isDisabled);

  // If there are available docks and waiting vehicles
  if (availableDocks.length > 0 && waitingVehicles.length > 0) {
    // Iterate through available docks and waiting vehicles
    availableDocks.forEach(dock => {
      const nextVehicle = waitingVehicles.shift(); // Get the next vehicle from the waiting list
      dock.status = 'occupied';
      dock.vehicleNumber = nextVehicle.vehicleNumber;
      dock.unloadingTime = nextVehicle.unloadingTime;
      dock.is3PL = nextVehicle.is3PL;
      dock.source = nextVehicle.source;
      
      // Emit socket event to update dock status
      io.emit('dockStatusUpdate', { docks, waitingVehicles });
      
      // Log the assignment
      console.log(`Vehicle ${nextVehicle.vehicleNumber} assigned to dock ${dock.dockNumber}`);
    });
  }

  prioritizeWaitingVehicles();
}

// Run assignWaitingVehiclesToDocks anytime you want to assign waiting vehicles to docks
// For example, you can call it periodically using setInterval
setInterval(assignWaitingVehiclesToDocks, 60000); // Run every minute (adjust as needed)
app.get('/', (req, res) => {
  res.status(200).json({ message: `Server is running fine at ${PORT}!` });
});

// Get dock status
app.get('/api/dock-status', (req, res) => {
  res.status(200).json({ docks, waitingVehicles });
});

app.post('/api/release-dock', (req, res) => {
  const { dockId } = req.body;
  const dockIndex = docks.findIndex(dock => dock.id === dockId);

  if (dockIndex === -1) {
    return res.status(404).json({ message: 'Dock not found.' });
  }

  if (docks[dockIndex].status === 'occupied') {
    const dock = docks[dockIndex];
    const releasedVehicleNumber = dock.vehicleNumber;
    dock.status = 'available';
    dock.vehicleNumber = null;
    dock.unloadingTime = null;
    dock.is3PL = null;
    dock.source = null;

    assignWaitingVehiclesToDocks();

    return res.status(200).json({ message: `Dock ${dock.dockNumber} is now available. Vehicle ${releasedVehicleNumber} has been undocked.` });
  } else {
    return res.status(404).json({ message: `Dock is not occupied or does not exist.` });
  }
});

app.post('/api/initialize-docks', (req, res) => {
  docks = Array.from({ length: 10 }, (_, i) => ({
    dockNumber: i + 1,
    status: 'available',
    vehicleNumber: null,
    source: null,
    unloadingTime: null,
    is3PL: null,
    isDisabled: false, // Initialize all docks as enabled
  }));

  waitingVehicles = [];
  io.emit('dockStatusUpdate', { docks, waitingVehicles });
  res.status(200).json({ message: `Docks are initialized` });
});

app.post('/api/disable-dock', (req, res) => {
  const { dockNumber } = req.body;
  const dock = docks.find(d => d.dockNumber === dockNumber);

  console.log(`${dock.id} has been disabled!`);

  if (dock) {
    dock.isDisabled = true;
    dock.status = 'disabled';
    io.emit('dockStatusUpdate', { docks, waitingVehicles });
    return res.status(200).json({ message: `Dock ${dockNumber} is now disabled` });
  } else {
    res.status(404).json({ message: `Dock ${dockNumber} does not exist.` });
  }
});

app.post('/api/enable-dock', (req, res) => {
  const { dockNumber } = req.body;
  const dock = docks.find(d => d.dockNumber === dockNumber);

  if (dock) {
    dock.isDisabled = false;
    dock.status = 'available';
    io.emit('dockStatusUpdate', { docks, waitingVehicles });
    return res.status(200).json({ message: `Dock ${dockNumber} is now enabled` });
  } else {
    res.status(404).json({ message: `Dock ${dockNumber} does not exist.` });
  }
});

io.on('connection', (socket) => {
  console.log('A user connected');
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

