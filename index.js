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
    origin: 'https://dock-mgmt.netlify.app/',
    methods: ["GET", "POST"]
  }
});


const PORT =process.env.PORT || 5000;

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

function assignDock(vehicle) {
  const { vehicleNumber, source, unloadingTime, is3PL } = vehicle;
  let assignedDock = null;

  const dockWithSameSource = docks.find(dock => dock.source === source && dock.source !== 'PH' && dock.status === 'occupied');
  if (dockWithSameSource)
    return null;

  if (is3PL) {
    assignedDock = docks.find(dock => dock.status === 'available' && dock.dockNumber >= 7 && dock.dockNumber <= 9 && !dock.isDisabled);
  } else {
    const isPHVehicle = source === 'PH';

    if (isPHVehicle) {
      if (phDockNumbers.length < 2) {
        if (phDockNumbers.length === 0) {
          assignedDock = docks.find(dock => dock.status === 'available' && (dock.dockNumber <= 6 || dock.dockNumber === 10) && !dock.isDisabled);
        } else {
          assignedDock = docks.find(dock => phDockNumbers.includes(dock.dockNumber) && !dock.isDisabled);
        }
      }
    }

    if (!isPHVehicle && !assignedDock) {
      assignedDock = docks.find(dock => dock.status === 'available' && dock.source !== source && !dock.isDisabled);
    }
  }

  if (assignedDock) {
    const dockIndex = docks.findIndex(dock => dock.dockNumber === assignedDock.dockNumber);

    const newAssignment = {
      dockNumber: assignedDock.dockNumber,
      status: 'occupied',
      vehicleNumber,
      source,
      unloadingTime,
      is3PL,
      id: `${assignedDock.dockNumber}-${vehicleNumber}`
    };

    if (source === 'PH') {
      phDockNumbers.push(assignedDock.dockNumber);
    }

    docks[dockIndex] = newAssignment;
    return assignedDock.dockNumber;
  } else {
    return null;
  }
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

function assignAndPrioritizeDock(vehicle) {
  const dockNumber = assignDock(vehicle);
  if (dockNumber !== null) {
    prioritizeDocks();
    io.emit('dockStatusUpdate', { docks, waitingVehicles }); // Emit updates here as well
    return dockNumber;
  }
  return null;
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

// Modify the '/api/assign-dock' endpoint to prioritize waiting list
app.post('/api/assign-dock', (req, res) => {
  const { vehicleNumber, source, unloadingTime, is3PL } = req.body;

  const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });

  const isOnTime = compareTimes(source, currentTime);

  let assignedDockNumber = null;
  if (isOnTime || docks.some(dock => dock.status === 'available' && !dock.isDisabled)) {
    assignedDockNumber = assignAndPrioritizeDock({ vehicleNumber, source, unloadingTime, is3PL });
  }

  if (assignedDockNumber) {
    io.emit('dockStatusUpdate', { docks, waitingVehicles });
    return res.status(200).json({ message: `Dock ${assignedDockNumber} assigned to vehicle ${vehicleNumber}` });
  }

  const assignedDock = docks.find(dock => dock.source === source);
  waitingVehicles.push({ vehicleNumber, source, unloadingTime, is3PL, dockNumber: assignedDock ? assignedDock.dockNumber : null });

  prioritizeWaitingVehicles();

  io.emit('dockStatusUpdate', { docks, waitingVehicles });
  res.status(200).json({ message: 'All docks are full or the vehicle is late, added to waiting list' });
});
app.get('/',(req,res)=>{
    res.status(200).json({message:`Server is running fine at ${PORT}!`});
})
// Get dock status
app.get('/api/dock-status', (req, res) => {
  res.status(200).json({ docks, waitingVehicles });
});

app.post('/api/release-dock', (req, res) => {
  const { dockId } = req.body;
  const dockIndex = docks.findIndex(dock => dock.id === dockId);

  if (dockIndex !== -1 && docks[dockIndex].status === 'occupied') {
    const dock = docks[dockIndex];
    const releasedVehicleNumber = dock.vehicleNumber;
    dock.status = 'available';
    dock.vehicleNumber = null;
    dock.unloadingTime = null;
    dock.is3PL = null;

    if (waitingVehicles.length > 0) {
      const index = waitingVehicles.findIndex(vehicle => vehicle.source === dock.source);

      if (index !== -1) {
        const nextVehicle = waitingVehicles.splice(index, 1)[0];

        docks[dockIndex].status = 'occupied';
        docks[dockIndex].vehicleNumber = nextVehicle.vehicleNumber;
        docks[dockIndex].unloadingTime = nextVehicle.unloadingTime;
        docks[dockIndex].is3PL = nextVehicle.is3PL;
        docks[dockIndex].source = nextVehicle.source;

        io.emit('dockStatusUpdate', { docks, waitingVehicles });
        return res.status(200).json({ message: `Dock ${dock.dockNumber} is now available. Vehicle ${releasedVehicleNumber} has been undocked. Vehicle ${nextVehicle.vehicleNumber} from waiting list has been assigned to dock.` });
      }
    }

    dock.source = null;
    io.emit('dockStatusUpdate', { docks, waitingVehicles });
    return res.status(200).json({ message: `Dock ${dock.dockNumber} is now available. Vehicle ${releasedVehicleNumber} has been undocked.` });
  } else {
    res.status(404).json({ message: `Dock is not occupied or does not exist.` });
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
