import * as express from "express";
import * as http from "http";
import * as socketio from "socket.io";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import socketioclient from "socket.io-client";
import sqlite3 from 'sqlite3'
import * as sqlite from 'sqlite'
import cfg from '../config.json'
import * as tmi from 'tmi.js';
import crypto from "crypto";
const USE_MOCK = !!process.env.USE_FDGT_MOCK;
let aUserlist : string [] = [];
let aChatlist : string [] = [];
let aTOlist : string [] = [];

(async () => {
  // open the database
  const db = await sqlite.open({
    filename: './data.db',
    driver: sqlite3.Database
  });
  await db.open();
  await db.run('CREATE TABLE IF NOT EXISTS subs (timestamp INTEGER, ending_at INTEGER, seconds_per_sub INTEGER, plan TEXT, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS sub_bombs (timestamp INTEGER, amount_subs INTEGER, plan TEXT, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS cheers (timestamp INTEGER, ending_at INTEGER, amount_bits INTEGER, user_name TEXT);');
  await db.run('CREATE TABLE IF NOT EXISTS graph (timestamp INTEGER, ending_at INTEGER);');
  await db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER);');

  const twitch = !USE_MOCK ? tmi.Client({
    channels: [cfg.channel.toLowerCase()],
    identity: cfg.twitch_token ? {
      username: cfg.channel.toLowerCase(),
      password: cfg.twitch_token
    } : undefined
  }) : tmi.Client({
    options: {debug: true},
    channels: [cfg.channel],
    identity: {
      username: "test",
      password: "oauth:test"
    },
    connection: {
      secure: true,
      server: 'irc.fdgt.dev'
    }
  });

  await twitch.connect().catch(console.error);

  const app = express.default();
  app.use(express.static('public'));

  const server = http.createServer(app);
  const io = new socketio.Server(server);

  let isStarted = false;
  let startedAt = 0;
  let maxTime = 0;

  const resStart = await db.get("SELECT * FROM settings WHERE key='started_at';");
  if(resStart) {
    isStarted = true;
    startedAt = resStart.value;
    console.log(`Found started_at in data.db: ${new Date(startedAt).toISOString()}`);
  }

  let baseTime = cfg.time.base_value;
  const resTime = await db.get("SELECT * FROM settings WHERE key='base_time';");
  if(resTime) {
    baseTime = resTime.value;
    console.log(`Found base_time in data.db: ${baseTime}`);
  }

  let endingAt = 0;
  const resEndingAt = await db.get("SELECT timestamp,ending_at FROM subs UNION ALL SELECT timestamp,ending_at FROM graph ORDER BY timestamp DESC;")
  if(resEndingAt) {
    endingAt = resEndingAt.ending_at;
    console.log(`Found last timer value in data.db: Ending at ${new Date(endingAt).toISOString()}`);
  }
  
  const resMaxTime = await db.get("SELECT * FROM settings WHERE key='max_time';");
  if(resMaxTime) {
    maxTime = resMaxTime.value;
    console.log(`Found max_time in data.db: ${new Date(maxTime).toISOString()}`);
  }


  const appState = new AppState(twitch, db, io, isStarted, startedAt, endingAt, baseTime, maxTime);

  registerSocketEvents(appState);
  registerTwitchEvents(appState);
  if(cfg.use_streamlabs) {
    registerStreamlabsEvents(appState);
  }
  if(cfg.use_streamelements) {
    registerStreamelementsEvents(appState)
  }

  server.listen(cfg.port, () => {
    console.log(`Open the timer at http://localhost:${cfg.port}/timer.html`);
    console.log(`There is also a popup for time changes with reason available at http://localhost:${cfg.port}/reason_popup.html`)
    if(USE_MOCK) {
      setInterval(async () => {
        await twitch.say(cfg.channel, 'submysterygift');
        console.log("submysterygift");
      }, 22000);
    }
  });
})();

function registerTwitchEvents(state: AppState) {
  state.twitch.on('message', async (channel: string, userstate: tmi.ChatUserstate, message: string, self: boolean) => {
    if(self) return;
    if(!isWheelBlacklisted(userstate.username||"")) {
      if(Math.random() > 0.90) {
        state.randomTarget = userstate.username || "";
        state.randomTargetIsMod = userstate.mod || false;
      }
    }
	if(!isWheelBlacklisted(userstate.username||"")) {
		AddChatter ( userstate.username||"" );
	}
    if(message.startsWith('?') && isAdmin(userstate.username||"")) {
      {
        // ?start
        const match = message.match(/^\?start ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(!state.isStarted) {
            const timeStr = match[1].split(":");
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              await state.start((((hours * 60) + minutes) * 60) + seconds);
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              await state.start((minutes * 60) + seconds);
            }
          }
        }
      }

      {
        // ?setbasetime
        const match = message.match(/^\?setbasetime (\d+)/);
        if(match) {
          await state.updateBaseTime(parseInt(match[1], 10));
        }
      }

      {
        // ?forcetimer
        const match = message.match(/^\?forcetimer ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(state.isStarted) {
            const timeStr = match[1].split(":");
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              await state.forceTime((((hours * 60) + minutes) * 60) + seconds);
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              await state.forceTime((minutes * 60) + seconds);
            }
          }
        }
      }

      {

        // ?forceuptime
        const match = message.match(/^\?forceuptime ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(state.isStarted) {
            const timeStr = match[1].split(":");
            let minusSeconds;
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              minusSeconds = (((hours*60) + minutes) * 60) + seconds
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              minusSeconds = (minutes * 60) + seconds
            }
            await state.updateStartedAt(Date.now() - (minusSeconds * 1000))
          }
        }

      }
	  
	  {

        // ?maxtime
        const match = message.match(/^\?maxtime ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(state.isStarted) {
            const timeStr = match[1].split(":");
            let maxSeconds;
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              maxSeconds = (((hours*60) + minutes) * 60) + seconds
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              maxSeconds = (minutes * 60) + seconds
            }
			await state.updateMaxTime(state.startedAt + (maxSeconds * 1000))
          }
        }

      }
	  
	  {

        // ?addtime
        const match = message.match(/^\?addtime ((\d+:)?\d{2}:\d{2})/);
        if(match) {
          if(state.isStarted) {
            const timeStr = match[1].split(":");
            let addSeconds;
            if(timeStr.length === 3) {
              const hours = parseInt(timeStr[0], 10);
              const minutes = parseInt(timeStr[1], 10);
              const seconds = parseInt(timeStr[2], 10);
              addSeconds = (((hours*60) + minutes) * 60) + seconds
            } else {
              const minutes = parseInt(timeStr[0], 10);
              const seconds = parseInt(timeStr[1], 10);
              addSeconds = (minutes * 60) + seconds
            }
			await state.addTime(addSeconds)
          }
        }

      }

    }
	
	if(userstate.username == "soundalerts") {
	
		const aMessage = message.split(" ");
		
		//<user> played <sound> for <amount> Bits!
		//0 = <user>
		//played <sound> for 
		// length - 2 = <amount>
		// length - 1 = Bits!
		if ( aMessage.length > 5 ) {
			if (aMessage[aMessage.length - 1] === "Bits!") {
				const sbits = aMessage[aMessage.length - 2];
				const bits = parseInt(sbits);
				if(state.endingAt < Date.now()) return;
				const multiplier = cfg.time.multipliers.bits;
				const secondsToAdd = Math.round((bits / 100) * multiplier * state.baseTime * 1000) / 1000;
				state.addTime(secondsToAdd);
				state.displayAddTimeUpdate(secondsToAdd, `${aMessage[0]} (bits)`);
				await state.db.run('INSERT INTO cheers VALUES(?, ?, ?, ?);', [Date.now(), state.endingAt, bits, aMessage[0]]);
				
				// quick mafs bit equivalent spin - comparison = ((( res.min_subs * tier_1 ) / bits multiplier ) * 100)
							
				const username = aMessage[0];
				
				let possibleResults = cfg.wheel.filter(res => ((( res.min_subs * cfg.time.multipliers.tier_1 ) / cfg.time.multipliers.bits ) * 100) <= bits);
				if(isWheelBlacklisted(username)) {
					possibleResults = possibleResults.filter(res => !(res.type === "timeout" && res.target === "sender"));
				}
				if(possibleResults.length > 0) {
					const totalChances = possibleResults.map(r => r.chance).reduce((a,b) => a+b);
					possibleResults.forEach(r => r.chance = r.chance / totalChances);
					const rand = Math.random();
					let result = possibleResults[0];
					let resRand = 0;
					for (const sp of possibleResults) {
						resRand += sp.chance;
						if(resRand >= rand) {
							result = sp;
							break;
						}	
					}
			
					const spinId = crypto.randomBytes(8).toString("hex");
					const spin = {results: possibleResults, random: rand, id: spinId, res: result, sender: username||"", mod: state.twitch.isMod ( cfg.channel.toLowerCase(), username )};
					state.spins.set(spinId, spin);
					state.io.emit('display_spin', spin);
				}
				
			}
		
			//<user> used <amount> Bits to play <sound>
			// 0 = <user>
			// 1 = used
			// 3 = <amount>
			// 4 = Bits
			//to play <sound>
			if (aMessage[4] === "Bits")
			{
				const sbits = aMessage[3];
				const bits = parseInt(sbits);
				if(state.endingAt < Date.now()) return;
				const multiplier = cfg.time.multipliers.bits;
				const secondsToAdd = Math.round((bits / 100) * multiplier * state.baseTime * 1000) / 1000;
				state.addTime(secondsToAdd);
				state.displayAddTimeUpdate(secondsToAdd, `${aMessage[0]} (bits)`);
				await state.db.run('INSERT INTO cheers VALUES(?, ?, ?, ?);', [Date.now(), state.endingAt, bits, aMessage[0]]);
				
				// quick mafs bit equivalent spin - comparison = ((( res.min_subs * tier_1 ) / bits multiplier ) * 100)
				
				const username = aMessage[0];
				let possibleResults = cfg.wheel.filter(res => ((( res.min_subs * cfg.time.multipliers.tier_1 ) / cfg.time.multipliers.bits ) * 100) <= bits);
				if(isWheelBlacklisted(username)) {
					possibleResults = possibleResults.filter(res => !(res.type === "timeout" && res.target === "sender"))
				}
				if(possibleResults.length > 0) {
					const totalChances = possibleResults.map(r => r.chance).reduce((a,b) => a+b);
					possibleResults.forEach(r => r.chance = r.chance / totalChances);
					const rand = Math.random();
					let result = possibleResults[0];
					let resRand = 0;
					for (const sp of possibleResults) {
						resRand += sp.chance;
						if(resRand >= rand) {
							result = sp;
							break;
						}	
					}
			
					const spinId = crypto.randomBytes(8).toString("hex");
					const spin = {results: possibleResults, random: rand, id: spinId, res: result, sender: username||"", mod: state.twitch.isMod ( cfg.channel.toLowerCase(), username )};
					state.spins.set(spinId, spin);
					state.io.emit('display_spin', spin);
				}
			}
		}
	}
		
  });

  state.twitch.on('subgift', async (channel: string, username: string, streakMonths: number, recipient: string,
                        methods: tmi.SubMethods, _userstate: tmi.SubGiftUserstate) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('submysterygift', async (channel: string, username: string, numbOfSubs: number,
                               methods: tmi.SubMethods, userstate: tmi.SubMysteryGiftUserstate) => {
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsAdded = Math.round(state.baseTime * multiplier * 1000 * numbOfSubs) / 1000;
    state.displayAddTimeUpdate(secondsAdded, `${username || "anonymous"} (subgift)`);
    let possibleResults = cfg.wheel.filter(res => res.min_subs <= numbOfSubs);
    if(isWheelBlacklisted(username)) {
      possibleResults = possibleResults.filter(res => !(res.type === "timeout" && res.target === "sender"))
    }
    if(possibleResults.length > 0) {
      const totalChances = possibleResults.map(r => r.chance).reduce((a,b) => a+b);
      possibleResults.forEach(r => r.chance = r.chance / totalChances);
      const rand = Math.random();
      let result = possibleResults[0];
      let resRand = 0;
      for (const sp of possibleResults) {
        resRand += sp.chance;
        if(resRand >= rand) {
          result = sp;
          break;
        }
      }

      const spinId = crypto.randomBytes(8).toString("hex");
      const spin = {results: possibleResults, random: rand, id: spinId, res: result, sender: userstate.login||"", mod: userstate.mod};
      state.spins.set(spinId, spin);
      state.io.emit('display_spin', spin);
      await state.db.run('INSERT INTO sub_bombs VALUES(?, ?, ?, ?);', [Date.now(), numbOfSubs, methods.plan||"undefined", username]);
    }
  });

  state.twitch.on('subscription', async (channel: string, username: string, methods: tmi.SubMethods,
                             _message: string, _userstate: tmi.SubUserstate) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    state.displayAddTimeUpdate(secondsToAdd, `${username} (sub)`);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('resub', async (channel: string, username: string, months: number, message: string,
                      userstate: tmi.SubUserstate, methods: tmi.SubMethods) => {
    if(state.endingAt < Date.now()) return;
    const multiplier = multiplierFromPlan(methods.plan);
    const secondsToAdd = Math.round(state.baseTime * multiplier * 1000) / 1000;
    state.addTime(secondsToAdd);
    state.displayAddTimeUpdate(secondsToAdd, `${username || "anonymous"} (sub)`);
    await state.db.run('INSERT INTO subs VALUES(?, ?, ?, ?, ?);', [Date.now(), state.endingAt, methods.plan||"undefined", username]);
  });

  state.twitch.on('cheer', async (channel: string, userstate: tmi.ChatUserstate, _message: string) => {
    const bits = parseInt(userstate.bits || "0", 10);
    if(state.endingAt < Date.now()) return;
    const multiplier = cfg.time.multipliers.bits;
    const secondsToAdd = Math.round((bits / 100) * multiplier * state.baseTime * 1000) / 1000;
    state.addTime(secondsToAdd);
    state.displayAddTimeUpdate(secondsToAdd, `${userstate.username || "anonymous"} (bits)`);
    await state.db.run('INSERT INTO cheers VALUES(?, ?, ?, ?);', [Date.now(), state.endingAt, bits, userstate.username||"ananonymouscheerer"]);
	
	// quick mafs bit equivalent spin - comparison = ((( res.min_subs * tier_1 ) / bits multiplier ) * 100)
	
	const username = (userstate.username || "anonymous");
	let possibleResults = cfg.wheel.filter(res => ((( res.min_subs * cfg.time.multipliers.tier_1 ) / cfg.time.multipliers.bits ) * 100) <= bits);
	if(isWheelBlacklisted(username)) {
		possibleResults = possibleResults.filter(res => !(res.type === "timeout" && res.target === "sender"))
	}
	if(possibleResults.length > 0) {
		const totalChances = possibleResults.map(r => r.chance).reduce((a,b) => a+b);
		possibleResults.forEach(r => r.chance = r.chance / totalChances);
		const rand = Math.random();
		let result = possibleResults[0];
		let resRand = 0;
		for (const sp of possibleResults) {
			resRand += sp.chance;
			if(resRand >= rand) {
				result = sp;
				break;
			}	
		}
		
		const spinId = crypto.randomBytes(8).toString("hex");
		const spin = {results: possibleResults, random: rand, id: spinId, res: result, sender: username||"", mod: userstate.mod};
		state.spins.set(spinId, spin);
		state.io.emit('display_spin', spin);
	}
  });
  
  state.twitch.on('join', async (channel: string, user: string, self: boolean) => {
	if(!isWheelBlacklisted(user)) {
		AddUser ( user );
	}
	if ( self )
	{
		console.log ("getting mods");
		await state.twitch.mods(cfg.channel.toLowerCase());
	}
  });
  
  state.twitch.on('part', async (channel: string, user: string, self: boolean) => {
    RemoveUser ( user );
  });
}

function registerSocketEvents(state: AppState) {
  state.io.on('connection', async (socket) => {
    socket.emit('update_incentives', {
      'tier_1': Math.round(state.baseTime * cfg.time.multipliers.tier_1),
      'tier_2': Math.round(state.baseTime * cfg.time.multipliers.tier_2),
      'tier_3': Math.round(state.baseTime * cfg.time.multipliers.tier_3),
      'bits': Math.round(state.baseTime * cfg.time.multipliers.bits),
      'donation': Math.round(state.baseTime * cfg.time.multipliers.donation),
      'follow': Math.round(state.baseTime * cfg.time.multipliers.follow)
    });
    socket.emit('update_timer', {'ending_at': state.endingAt, 'forced': true});
    socket.emit('update_uptime', {'started_at': state.startedAt});
    await state.broadcastGraph();

    for(const spin of state.spins.values()) {
      socket.emit('display_spin', spin);
    }
    socket.on('spin_completed', async spinId => {
      await state.executeSpinResult(spinId);
    });});
}

function isAdmin(username: string) {
  return cfg.admins.filter(admin => admin.toLowerCase() === username.toLowerCase()).length > 0
}

function isWheelBlacklisted(username: string) {
  return cfg.wheel_blacklist.filter(b => b.toLowerCase() === username.toLowerCase()).length > 0
}

function registerStreamlabsEvents(state: AppState) {
  const slabs = socketioclient(`https://sockets.streamlabs.com?token=${cfg.streamlabs_token}`, {transports: ['websocket']});
  slabs.on('event', (eventData : any) => {
    if(eventData.type === 'donation') {
      for(const msg of eventData.message) {
        const amount = msg.amount;
        if(amount == null) {
          console.log(`Error adding donation! Amount seems to be null. Message: ${JSON.stringify(eventData)}`)
          return;
        }
        if(state.endingAt < Date.now()) return;
        const secondsToAdd = Math.round(state.baseTime * amount * cfg.time.multipliers.donation * 1000) / 1000;
        state.addTime(secondsToAdd);
        state.displayAddTimeUpdate(secondsToAdd, `${msg.name} (tip)`);
      }
    } else if(eventData.type === 'follow') {
      if(state.endingAt < Date.now()) return;
      const secondsToAdd = Math.round(state.baseTime * cfg.time.multipliers.follow * 1000) / 1000;
      const name = eventData.message[0]?.name || "undefined";
      state.addTime(secondsToAdd);
      state.displayAddTimeUpdate(secondsToAdd, `${name} (follow)`);
    }
  });
  slabs.on("connect_error", (err: any) => {
    console.log(`streamlabs connection error: ${err}`);
  });
  slabs.on("connect", () => {
    console.log(`successfully connected to streamlabs socket`);
  });
  slabs.on("reconnecting", (attempt: any) => {
    console.log(`streamlabs reconnecting (attempt ${attempt})`);
  });
  slabs.on("disconnect", (reason: any) => {
    console.log(`streamlabs disconnected! (${reason}) is your token valid?`);
  });
}

function AddChatter ( user: string )
  {
    let bUserExists = false;
    for (var i = 0; i < aChatlist.length; i++)
    {
      if ( user == aChatlist[i] )
      {
        bUserExists = true;
        break;
      }
    }
    if (!bUserExists) { /*console.log ("adding chatter: " + user );*/ aChatlist.push ( user ); }
  }

function AddUser ( user: string )
  {
    let bUserExists = false;
    for (var i = 0; i < aUserlist.length; i++)
    {
      if ( user == aUserlist[i] )
      {
        bUserExists = true;
        break;
      }
    }
    if (!bUserExists) { /*console.log ("adding user: " + user );*/ aUserlist.push ( user ); }
  }

  function RemoveUser ( user: string )
  {
    for (var i = 0; i < aUserlist.length; i++)
    {
      if ( user == aUserlist[i] )
      {
        //console.log ( "Removing User: " + user );
        aUserlist.splice(i, 1);
        break;
      }
    }
  }
  
  function RemoveTOUser ( user: string )
  {
    for (var i = 0; i < aTOlist.length; i++)
    {
      if ( user == aTOlist[i] )
      {
		//console.log ("removing timed out user: " + user );
        aTOlist.splice(i, 1);
        break;
      }
    }
  }

function registerStreamelementsEvents(state: AppState) {
  const seSocket = socketioclient(`https://realtime.streamelements.com`, {transports: ['websocket']});

  seSocket.on('event', (event: any) => {
    if(event.type == 'tip') {
      if(state.endingAt < Date.now()) return;
      const secondsToAdd = Math.round(state.baseTime * event.data.amount * cfg.time.multipliers.donation * 1000) / 1000;
      state.addTime(secondsToAdd);
      state.displayAddTimeUpdate(secondsToAdd, `${event.data.displayName || event.data.username || "anonymous"} (tip)`);
	  
	  // quick mafs dono equivalent spin - comparison = (( res.min_subs * tier_1 ) * dono multiplier )
		
	  let possibleResults = cfg.wheel.filter(res => (( res.min_subs * cfg.time.multipliers.tier_1 ) * cfg.time.multipliers.donation ) <= event.data.amount);
	  // can't relate to a twitch user
	  possibleResults = possibleResults.filter(res => !(res.type === "timeout" && res.target === "sender"))
	  if(possibleResults.length > 0) {
	    const totalChances = possibleResults.map(r => r.chance).reduce((a,b) => a+b);
	    possibleResults.forEach(r => r.chance = r.chance / totalChances);
	    const rand = Math.random();
		let result = possibleResults[0];
		let resRand = 0;
		for (const sp of possibleResults) {
		  resRand += sp.chance;
		  if(resRand >= rand) {
		    result = sp;
			break;
		  }	
		}

		const spinId = crypto.randomBytes(8).toString("hex");
		const spin = {results: possibleResults, random: rand, id: spinId, res: result, sender: "", mod: false};
		state.spins.set(spinId, spin);
		state.io.emit('display_spin', spin);
	  }
    } else if(event.type == 'follower') {
      if(state.endingAt < Date.now()) return;
      const secondsToAdd = Math.round(state.baseTime * cfg.time.multipliers.follow * 1000) / 1000;
      state.addTime(secondsToAdd);
      state.displayAddTimeUpdate(secondsToAdd, `${event.data.displayName} (follow)`);
    }
  });

  seSocket.on("connect", () => {
    seSocket.emit('authenticate', {method: 'jwt', token: cfg.streamelements_token});
  })
  seSocket.on("connect_error", (err: any) => {
    console.log(`streamelements connection error: ${err}`);
  });
  seSocket.on("reconnecting", (attempt: any) => {
    console.log(`streamelements reconnecting (attempt ${attempt})`);
  });
  seSocket.on("disconnect", (reason: any) => {
    console.log(`streamelements disconnected! (${reason}) is your token valid?`);
  });
  seSocket.on('unauthorized', console.log);
  seSocket.on('authenticated', (data: any) => {
    const { channelId } = data;
    console.log(`streamelements: successfully connected to channel ${channelId}`)
  });

}

class AppState {
  twitch: tmi.Client;
  db: sqlite.Database;
  io: socketio.Server;

  isStarted: boolean;
  startedAt: number;

  endingAt: number;
  baseTime: number;
  
  maxTime: number;
  
  randomTarget = "definitelynotyannis";
  randomTargetIsMod = false;

  spins: Map<string, any> = new Map();

  constructor(twitch: tmi.Client, db: sqlite.Database, io: socketio.Server,
              isStarted: boolean, startedAt: number, endingAt: number, baseTime: number, maxTime: number) {
    this.twitch = twitch;
    this.db = db;
    this.io = io;
    this.isStarted = isStarted;
    this.startedAt = startedAt;
    this.endingAt = endingAt;
    this.baseTime = baseTime;
	this.maxTime = maxTime;

    setInterval(async () => {
      if(!this.isStarted || this.endingAt < Date.now()) return;
      await db.run(`INSERT INTO graph VALUES(?, ?);`, [Date.now(), this.endingAt]);
      // Keep only the latest 120 records
      await db.run('DELETE FROM graph WHERE timestamp IN (SELECT timestamp FROM graph ORDER BY timestamp DESC LIMIT -1 OFFSET 120);');
      await this.broadcastGraph();
    }, 1000*60);
  }

  async updateBaseTime(newBaseTime: number) {
    this.baseTime = newBaseTime;
    this.io.emit('update_incentives', {
      'tier_1': Math.round(this.baseTime * cfg.time.multipliers.tier_1),
      'tier_2': Math.round(this.baseTime * cfg.time.multipliers.tier_2),
      'tier_3': Math.round(this.baseTime * cfg.time.multipliers.tier_3),
      'bits': Math.round(this.baseTime * cfg.time.multipliers.bits),
      'donation': Math.round(this.baseTime * cfg.time.multipliers.donation),
      'follow': Math.round(this.baseTime * cfg.time.multipliers.follow)
    });
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['base_time', newBaseTime]);
  }

  async start(seconds: number) {
    this.isStarted = true;
    this.startedAt = Date.now();
	this.maxTime = 0;
    this.forceTime(seconds);
    this.io.emit('update_uptime', {'started_at': this.startedAt});
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['started_at', this.startedAt]);
  }

  async updateStartedAt(newStartedAt: number) {
    this.startedAt = newStartedAt
    this.io.emit('update_uptime', {'started_at': this.startedAt});
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['started_at', this.startedAt]);
  }
  
  async updateMaxTime(newMaxTime: number) {
    this.maxTime = newMaxTime
    await this.db.run('INSERT OR REPLACE INTO settings VALUES (?, ?);', ['max_time', this.maxTime]);
    if ( this.endingAt > this.maxTime ) {
	  this.endingAt = this.maxTime;
	}
    this.io.emit('update_timer', {'ending_at': this.endingAt});
  }

  forceTime(seconds: number) {
    this.endingAt = Date.now() + (seconds * 1000);
	if ( this.maxTime > 0 ) {
	  if ( this.endingAt > this.maxTime ) {
		this.endingAt = this.maxTime;
	  }
	}
    this.io.emit('update_timer', {'ending_at': this.endingAt, 'forced': true});
  }

  addTime(seconds: number) {
    if(seconds == null) {
      return
    }
	
	this.endingAt = this.endingAt + (seconds * 1000);
	if ( this.maxTime > 0 ) {
	  if ( this.endingAt > this.maxTime ) {
		this.endingAt = this.maxTime;
	  }
	}
    this.io.emit('update_timer', {'ending_at': this.endingAt});
  }

  displayAddTimeUpdate(seconds: number, reason: string) {
	if ( this.maxTime > 0 ) {
	  if ( this.endingAt != this.maxTime ) {
		this.io.emit('time_add_reason', {'seconds_added': seconds, 'reason': reason})
	  }
	}
  }

  async executeSpinResult(spinId: string) {
    if(!this.spins.has(spinId)) return;
    const spin = this.spins.get(spinId);
    this.spins.delete(spinId);

    if(spin.res.type === 'time') {
      this.addTime(spin.res.value);
      this.displayAddTimeUpdate(spin.res.value, `${spin.sender} (wheel)`)
    } else if(spin.res.type === 'timeout') {
      if(spin.res.target === 'random') {
        let checks = 0;
		let target = "";
		while ( !target )
		{
			if (checks == 10 ) { break; }
			let x = Math.floor(Math.random() * (aChatlist.length - 1));
			for (var i = 0; i < aUserlist.length; i++)
			{
				if ( aChatlist[x].toLowerCase() == aUserlist[i].toLowerCase() )
				{
					target = aChatlist[x].toLowerCase();
				}
				console.log ("checking user: " + aChatlist[x].toLowerCase() );
				// check if timed out already
				for (var j = 0; j < aTOlist.length; j++)
				{
					console.log ("TO: " + aTOlist[j] );					
					if ( aChatlist[x].toLowerCase() == aTOlist[j] )
					{
						console.log ("user timed out: " + aChatlist[x].toLowerCase() );
						target = "";
					}
				}
			}
			checks++;
		}
		if ( !target ) { console.log ( "failed to find a user" ); return; }
        const targetIsMod = this.twitch.isMod ( cfg.channel.toLowerCase(), target );
        await this.twitch.timeout(cfg.channel, target, spin.res.value, "WHEEL SPIN").catch(err => console.log('Could not execute wheel TO!', err));
        if(targetIsMod) {
          console.log(`Remodding ${target} in ${(1000*spin.res.value) + 5000}ms`);
          setTimeout(async () => {
            await this.twitch.mod(cfg.channel, target).catch(err => console.log('Could not remod user after wheel TO!', err));
          }, (1000*spin.res.value) + 5000);
        }
		aTOlist.push ( target );
		setTimeout(async () => { RemoveTOUser(target); }, (1000*spin.res.value) + 5000);
      } else if(spin.res.target === 'sender') {
		const wasMod = this.twitch.isMod ( cfg.channel.toLowerCase(), spin.sender );
		console.log ("timing out current user: " + spin.sender + " - mod: " + wasMod );
        await this.twitch.timeout(cfg.channel, spin.sender, spin.res.value, "WHEEL SPIN").catch(err => console.log('Could not execute wheel TO!', err));
        if(wasMod) {
          console.log(`Remodding ${spin.sender} in ${(1000*spin.res.value) + 5000}ms`);
          setTimeout(async () => {
            await this.twitch.mod(cfg.channel, spin.sender).catch(err => console.log('Could not remod user after wheel TO!', err));
          }, (1000*spin.res.value) + 5000);
        }
		aTOlist.push ( spin.sender );
		setTimeout(async () => { RemoveTOUser(spin.sender); }, (1000*spin.res.value) + 5000);
      }
    }
  }

  async broadcastGraph() {
    const res = await this.db.all('SELECT timestamp,ending_at FROM graph ORDER BY timestamp DESC LIMIT 50;');
    const graphArray : any[] = Array.from({length: 60}, (_, n) => {
      if(res.length === 0) return 0;
      else if(n < 60 - res.length) return res[res.length - 1].ending_at - res[res.length - 1].timestamp;
      else return res[60-(1+n)].ending_at - res[60-(1+n)].timestamp;
    });
    this.io.emit('update_graph', {data: graphArray});
  }
  
}

function multiplierFromPlan(plan: tmi.SubMethod|undefined) {
  if(!plan) return cfg.time.multipliers.tier_1;
  switch (plan) {
    case "Prime":
      return cfg.time.multipliers.tier_1;
    case "1000":
      return cfg.time.multipliers.tier_1;
    case "2000":
      return cfg.time.multipliers.tier_2;
    case "3000":
      return cfg.time.multipliers.tier_3;
  }
}
