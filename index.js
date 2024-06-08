require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient, ServerApiVersion } = require('mongodb');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const moment = require('moment');

const { DateTime } = require('luxon'); 

// origin: 'http://localhost:3000' ,

const app = express();
app.use(bodyParser.json());
// Explicitly configure CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    
   origin: '*' ,

    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

const uri = process.env.MONGODB_URI;


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });


const database=client.db('Docks');
const db=database.collection('Docks');





let docks = Array.from({ length: 10}, (_, i) => ({
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
    availableDock = docks.find(dock => dock.dockNumber >= 7 && dock.dockNumber <= 9 && dock.status === 'available' && !dock.isDisabled);
  } else {
    let dockNumber=docks.length+1;
    for(let i=0;i<docks.length;i++)
      {
        if( docks[i].status === 'available' && !docks[i].isDisabled && docks[i].dockNumber<dockNumber)
          {
            dockNumber= docks[i].dockNumber;
            availableDock=docks[i]
                
          }
      }

     

    // availableDock = docks.find(dock => dock.status === 'available' && !dock.isDisabled);
  }

  if (source === 'PH') {
    // Find a dock number with 'available' status
    const availableDockForPH = docks.find(dock => dock.source === 'PH' && dock.status === 'available');

    // const dockList=docks.find(dock => dock.source === 'PH');
    // console.log("dockList:",dockList);
    // console.log("availableDock:",availableDockForPH);

    if (availableDockForPH) {
        // Update the existing dock with the new vehicle details
        availableDockForPH.status = 'occupied';
        availableDockForPH.vehicleNumber = vehicleNumber;
        availableDockForPH.unloadingTime = unloadingTime;
        availableDockForPH.is3PL = is3PL;
      

        // console.log("PH Dock updated successfully to dock with 'available' status!");
        io.emit('dockStatusUpdate', { docks, waitingVehicles });
        return availableDockForPH.dockNumber;
    } else {
        // Find a dock with exactly one 'PH' vehicle
        const targetDock = docks.find(dock => {
            if (dock.source === 'PH' && dock.status === 'occupied') {
                const countOnDock = docks.filter(d => d.dockNumber === dock.dockNumber && d.source === 'PH').length;
                return countOnDock === 1;
            }
            return false;
        });

        if (targetDock) {
            // Add the new 'PH' vehicle to the dock with exactly one 'PH' vehicle
            docks.push({
                dockNumber: targetDock.dockNumber,
                status: 'occupied',
                vehicleNumber,
                source,
                unloadingTime,
                is3PL,
                id: `${vehicleNumber}-${targetDock.dockNumber}`
            });
            // console.log("PH Dock Added successfully to dock with exactly one 'PH' vehicle!");
            io.emit('dockStatusUpdate', { docks, waitingVehicles });
            return targetDock.dockNumber;
               }}   

              }

     if(availableDock)
      {
        availableDock.id = `${vehicleNumber}-${availableDock.dockNumber}`;
        availableDock.status = 'occupied';
        availableDock.vehicleNumber = vehicleNumber;
        availableDock.source = source;
        availableDock.unloadingTime = unloadingTime;
        availableDock.is3PL = is3PL;


    
        io.emit('dockStatusUpdate', { docks, waitingVehicles });
          
       
        return availableDock.dockNumber;
        
      }

  return null;
}



function prioritizeWaitingVehicles() {
  waitingVehicles.sort((a, b) => {
    const currentTime = new Date().toLocaleTimeString('en-US', { hour12: false });
    const currentTimeMinutes = timeToMinutes(currentTime);

    const isFRKorGGN_A = a.source === 'FRK' || a.source === 'GGN';
    const isFRKorGGN_B = b.source === 'FRK' || b.source === 'GGN';

    // Prioritize FRK and GGN sources first
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

    const aDockInTime = timeToMinutes(routeA['dock in time']);
    const bDockInTime = timeToMinutes(routeB['dock in time']);

    const aLateness = Math.abs(aDockInTime - currentTimeMinutes);
    const bLateness = Math.abs(bDockInTime - currentTimeMinutes);

    const aPromiseTime = timeToMinutes(routeA['Promise']);
    const bPromiseTime = timeToMinutes(routeB['Promise']);

    const latenessBuffer = 30; // 30 minutes buffer

    if (aLateness > latenessBuffer && bLateness > latenessBuffer) {
      // Both are delayed beyond the buffer, prioritize by promise time
      return aPromiseTime - bPromiseTime;
    }

    if (aLateness <= latenessBuffer && bLateness > latenessBuffer) {
      // A is within buffer, B is late beyond buffer
      return -1;
    }

    if (aLateness > latenessBuffer && bLateness <= latenessBuffer) {
      // A is late beyond buffer, B is within buffer
      return 1;
    }

    if (aLateness <= latenessBuffer && bLateness <= latenessBuffer) {
      // Both are within buffer, prioritize by promise time
      return aPromiseTime - bPromiseTime;
    }

    // Fallback to promise time
    return aPromiseTime - bPromiseTime;
  });

  io.emit('dockStatusUpdate', { docks, waitingVehicles });
}








app.post('/api/assign-dock', async (req, res) => {
  const { vehicleNumber, source, unloadingTime, is3PL } = req.body;

  console.log("In assign dock!");

  if (docks.find(dock => dock.vehicleNumber === vehicleNumber)) {
    return res.status(400).json({ message: 'Invalid Vehicle Number!' });
  }

  let assignedDockNumber = null;

  // Check if there is an available dock
  if (docks.some(dock => (dock.status === 'available' && !dock.isDisabled) || (dock.source === 'PH' && !dock.isDisabled))) {
    assignedDockNumber = assignDock({ vehicleNumber, source, unloadingTime, is3PL });
  }

  console.log(`Assigned Dock Number: ${assignedDockNumber}`);
  if (assignedDockNumber !== null) {
    console.log('Control reaches here: Dock assigned');

    const currentTime = new Date();
    const addedTime = new Date(currentTime.getTime() + (5 * 60 + 30) * 60 * 1000);
    const dockInTimeReadable = moment(addedTime).format('h:mm a, MM/DD/YYYY');
    console.log("Dock In:", dockInTimeReadable);

    let newDock = {
      vehicleNumber: vehicleNumber,
      dockNumber: assignedDockNumber,
      source: source,
      dockInTime: dockInTimeReadable,
      dockOutTime: null
    };

    // Emit the dock status update before the database operation
    io.emit('dockStatusUpdate', { docks, waitingVehicles });

    // Send response first
    res.status(200).json({ message: `Dock ${assignedDockNumber} assigned to vehicle ${vehicleNumber}` });

    if (!db) {
      throw new Error('Database connection not established');
    }

    try {
      await db.insertOne(newDock);
      console.log('Document inserted successfully');
    } catch (err) {
      console.error('Error inserting document', err);
    }
    
    return;
  }

  // If no available dock, add the vehicle to the waiting list
  waitingVehicles.push({ vehicleNumber, source, unloadingTime, is3PL });
  prioritizeWaitingVehicles();

  // Emit the dock status update
  io.emit('dockStatusUpdate', { docks, waitingVehicles });

  // Send response
  return res.status(200).json({ message: 'All docks are full or the vehicle is late, added to waiting list' });
});


function assignWaitingVehiclesToDocks() {
  // Filter to find available docks
  const availableDocks = docks.filter((dock =>( dock.status === 'available' && !dock.isDisabled) || (dock.source==='PH' && !dock.isDisabled )));
  prioritizeWaitingVehicles();
  // Iterate through available docks and assign them to waiting vehicles
  availableDocks.forEach(dock => {
    if (waitingVehicles.length > 0) {
      const nextVehicle = waitingVehicles.shift(); // Get the next vehicle from the waiting list

      // Assign the vehicle to the dock
      const assignedDockNumber = assignDock({
        vehicleNumber: nextVehicle.vehicleNumber,
        source: nextVehicle.source,
        unloadingTime: nextVehicle.unloadingTime,
        is3PL: nextVehicle.is3PL
      });

      if (assignedDockNumber) {
        // Log the assignment
        // console.log(`Vehicle ${nextVehicle.vehicleNumber} assigned to dock ${assignedDockNumber}`);
      }
      
    // Prioritize waiting vehicles
    prioritizeWaitingVehicles();

      // Emit socket event to update dock status
      io.emit('dockStatusUpdate', { docks, waitingVehicles });
    }
  });


  // Emit socket event to update dock status after prioritizing
  io.emit('dockStatusUpdate', { docks, waitingVehicles });
}


// Run assignWaitingVehiclesToDocks anytime you want to assign waiting vehicles to docks
// For example, you can call it periodically using setInterval
setInterval(assignWaitingVehiclesToDocks, 60000); // Run every minute (adjust as needed)


// Get dock status
app.get('/api/dock-status', (req, res) => {
  res.status(200).json({ docks, waitingVehicles });
});

app.post('/api/release-dock', async(req, res) => {
  
 
  const { dockId } = req.body;
  const dockIndex = docks.findIndex(dock => dock.id === dockId);

  if (dockIndex === -1) {
    return res.status(404).json({ message: 'Dock not found.' });
  }

  const dock = docks[dockIndex];

  // Update the dockOutTime field

 // Get the current time
 const currentTime = new Date();
 const addedTime = new Date(currentTime.getTime() + (5 * 60 + 30) * 60 * 1000);
 const dockOutTimeReadable = moment(addedTime).format('h:mm a, MM/DD/YYYY');
 console.log("Dock out:",dockOutTimeReadable);

  if (!db) {
    throw new Error('Database connection not established');
  }

  try {
    const updateResult = await db.updateOne(
      { vehicleNumber: dock.vehicleNumber }, // Filter by vehicleNumber
      { $set: { dockOutTime: dockOutTimeReadable } } // Update dockOutTime
    );

    console.log("Document updated successfully:", updateResult.modifiedCount);
    
  } catch (err) {
    console.error('Error updating document', err);
    return res.status(500).json({ message: 'Internal Server Error' });
  }

  if (dock.status === 'occupied') {
      // Count the number of docks with the same dock number
    const sameDockNumberCount = docks.filter(d => d.dockNumber === dock.dockNumber).length;
    if (dock.source === 'PH'  && sameDockNumberCount > 1) {
    

   
        // Remove the dock from the docks array if the count is more than 1
        docks.splice(dockIndex, 1);
        // console.log(`PH Dock with id ${dockId} removed successfully.`);
        io.emit('dockStatusUpdate', { docks, waitingVehicles });
        assignWaitingVehiclesToDocks();
        return res.status(200).json({
          message: `Dock ${dock.dockNumber} with vehicle ${dock.vehicleNumber} has been removed.`,
          dockNumber: dock.dockNumber,
          vehicleNumber: dock.vehicleNumber
        });
    

    } else {
      // Reset the dock details for non-PH source
      const releasedVehicleNumber = dock.vehicleNumber;
      dock.status = 'available';
      dock.vehicleNumber = null;
      dock.unloadingTime = null;
      dock.is3PL = null;
      dock.source = null;

      // console.log(`Dock with id ${dockId} reset to available.`);


      io.emit('dockStatusUpdate', { docks, waitingVehicles });
      assignWaitingVehiclesToDocks();
      return res.status(200).json({
        message: `Dock ${dock.dockNumber} is now available. Vehicle ${releasedVehicleNumber} has been undocked.`,
        dockNumber: dock.dockNumber,
        vehicleNumber: releasedVehicleNumber
      });
    }
  } else {
    return res.status(400).json({ message: 'Dock is not occupied or does not exist.' });
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

  // console.log(`${dock.id} has been disabled!`);

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
  const { dock } = req.body;

  // Assuming docks is an array of dock objects
  const index = docks.findIndex(d => d.id === dock.id);

  if (index !== -1) { // Check if the dock exists in the array
    // Assuming docks is some kind of database or data management object
    // and it has a method called 'update' to update the dock information
    dock.isDisabled = false;
    docks[index] = dock; // Update the dock object in the array

    // Assuming 'io' is a socket.io instance for emitting events
    io.emit('dockStatusUpdate', { docks, waitingVehicles });

    return res.status(200).json({ message: `Dock ${dock.dockNumber} is now enabled` });
  } else {
    return res.status(404).json({ message: `Dock ${dock.dockNumber} does not exist.` });
  }
});


io.on('connection', (socket) => {
  console.log('A user connected');
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

