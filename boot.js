var sys = require('sys');

var errorHandler = require("./util/err"); 
var gh = require('grasshopper');
var io = require("socket.io");
//var io = require('../Socket.IO-node/index');

var util = require('./util/util');
var json = JSON.stringify;

var redisClient = require("./lib/redis-client").createClient();

gh.configure({
    viewsDir: './app/views',
    layout: './app/views/layout',
    
    //TODO: decide whether we need localization
    //one potential use for this might be 
    //locales: require('./locales')
});

["account", 
  "find", 
  "map", 
  "session", 
  "talk", 
  "join",
  "map"
].forEach(function(controller) {
    require("./app/controllers/" + controller);
});

gh.get("/", function() {
  this.disableCache();
  var now = new Date();

  this.model['now'] = now;
  this.render('home');
});
     
gh.serve(8080);
sys.puts("Server running on port 8080");

//clean up anything from the last session
//TODO: mark all dnd sessions as inactive
sys.puts("cleaning up old users");
redisClient.keys("users:*", function(e, oldUsers) {
  var oldUsers = oldUsers? oldUsers.toString().split(",") : [];
  
  _.each(oldUsers, function(oldUser, index) {
    sys.puts("removing key[" + oldUser + "]");
    redisClient.del(oldUser, function(e, result) {});
  });
  sys.puts("deleting all old sockets");
  redisClient.del("sockets", function(e, result) {});
  
  //reset all active rooms too
  redisClient.keys("*/users", function(e, userLists) {
    sys.puts("deleting old lists of users in active sessions");
    var userLists = userLists? userLists.toString().split(",") : [];
    
    _.each(userLists, function(sessionListKey, index) {
      redisClient.del(sessionListKey, function(e, result) {});
    });
  });
});

//initialize socket.io : I choose you!
var buffer = [], json = JSON.stringify;
var StartSocket = function() {
  sys.puts("starting up socket.io");
  //exported http.server from grasshopper
  var socket = io.listen(gh.server);
  
  //on connection, send out a small buffer, then configure on message handlers
  /*
    This is fairly complicated, what we initially expect from a user is their clientID, which we will use internally to identify them
    overriding the websocket sessionId would require hacking apart the client + server libraries, when I'm not up to yet
  */
  socket.on('connection', function(client){
  	client.send(json({ buffer: buffer }));
  	client.on('message', function(message){
  	  sys.puts("got message: " + message + " from: " + client.sessionId);
  	  var webSocketId = client.sessionId;
  	  
  	  //may as well keep a hash of websocket ids in the SOCKETS space simply for the convenience of looking it up based on their websockets clientId
    	redisClient.hget("sockets", webSocketId, function(e, clientId) {    	  
    	  sys.puts("WEBSOCKET START");
    	  sys.puts("got :" + clientId + " for socketId: " + webSocketId);
    	  
    	  if (e || (!clientId || clientId == null)) {//error, or we don't recognize this user
    	    sys.puts("error on redis, or we don't recognize this user.");
    	    //inspect message for an id, tell the client to disconnect otherwise
    	    //we need the ID here to identify them on future requests
    	    if (message.indexOf("ID:") < 0) {
    	      sys.puts("could not identify user with message:" + message);
    	      //TODO: implement a disconnect method
    	      //client.send(json('disconnect'));
    	      return false;
    	    }
    	    //otherwise, grab the id, stash it away in redis for now, until they try to chat again
    	    var id = message.substring(message.indexOf(":") + 1, message.length);
    	    sys.puts("setting userID: " + id + " for websocketId:" + webSocketId)
    	    
    	    if (!(id || id.length > 5)) {
    	      //client.send(json('disconnect'));
    	      return false;
    	    }
    	    
    	    redisClient.hset("sockets", webSocketId, id, function(e, result) {
    	      sys.puts("set id, getting info for key:" + id);
    	      if (e || !result) {
    	        sys.puts("failed to set websocket sessionId - clientId");
    	        //client.send(json('disconnect'));
    	        return false;
    	      }
    	      //get whitelist and announce that a user joined
    	      redisClient.hmget("users:" + id, "name", "room", "defaultImage", function(e, info) {
    	        var name = info[0].toString('utf8');
    	        var roomId = info[1].toString('utf8');
    	        var defaultImage = info[2].toString('utf8');
    	        
              sys.puts("got info for this client:");
    	        sys.puts("name: " + name + ", room: " + roomId);
    	        
    	        redisClient.lrange(roomId + "/users", 0, 10, function(e, whiteList) {
    	          //now that we've identified the user, their name + room, we can announce they joined
    	          whiteList = whiteList? whiteList.toString().split(",") : [];
    	          whiteList = _.without(whiteList, webSocketId);

    	          sys.puts("announcing user: " + name + " joined to " + whiteList);    	          
          	    client.broadcastOnly(json({ announcement: name + ' connected' , username: name, imageName: defaultImage}), whiteList);
          	    
          	    //push ourselves onto this list
          	    redisClient.rpush(roomId + "/users", webSocketId, function(e, result) {
          	      if (e || !result) {
          	        //client.send(json('disconnection'));
          	      }
          	    });
    	        });
    	      });
    	    });
  	    }
  	    else {
    	    //we have an id for this user, now we need their info         	    
    	    sys.puts("this clientId: " + clientId + " should be good.");
    	    redisClient.hmget("users:" + clientId, "name", "room", function(e, userInfo) {
    	      if (e || !userInfo || userInfo.length < 2) {
    	        sys.puts("error while getting userinfo for sessionId: " + clientId);
    	        //
    	        client.send(json('disconnect'));
    	        return false;
    	      }
  	      
    	      sys.puts("got userInfo for client with sessionId: " + clientId + " userinfo: " + userInfo);
  	      
    	      var name = userInfo[0].toString('utf8');
    	      var roomId = userInfo[1].toString('utf8');
    	      var websocketId = websocketId? websocketId : client.sessionId;
  	      
    	      //create message, whether it's a movement or message type
    	      var msg;
        	  var indexOfMove = message.indexOf("_move_");
        	  if (indexOfMove >= 0) {
        	    sys.puts("creating a move message");
        	    msg = {move : [name, message.substring(message.lastIndexOf("_"), message.length)]}
        	  }
        		else {
        		  msg = { message: [name, message] }; 
      		  }
    		  
      		  //this buffer currently stores a list of the last 15 messages (mainly for clients that connect midway through a session)
        		//may want to investigate using it to actually buffer client messages
        		//we would need to either call process.onNextTick or setTimeOut to use this effectively
        		//storing it in redis may not be a bad idea either, since actions there can be guaranteed atomic
        		buffer.push(msg);
        		if (buffer.length > 15) buffer.shift();

        		//ARGH, socket.io only supports blacklists by default
        		/*
              Updated my socket.io fork on accept a whitelist on the broadcastOnly method,
              since we have looked up their roomId, we can easily get a list of users in the room
        		*/

        		//time has passed since the client joined lowly roomId in a rousing game of XYZ, 
        		//now we need to look up the current whitelist and send this message back
        		redisClient.lrange(roomId + "/users", 0, 10, function(e, updatedWhiteList) {
        		  if (e) {return false;} 

        		  //TODO: remove self from updatedWhiteList
        		  updatedWhiteList = updatedWhiteList? updatedWhiteList.toString().split(",") : [];
        		  updatedWhiteList = _.without(updatedWhiteList, websocketId);
        		  
        		  sys.puts("got whitelist for this user. Going to send a message to: " + updatedWhiteList);
        		  client.broadcastOnly(json(msg), updatedWhiteList);
        		});
    	    });            
  	    }
	    });
		});

  	client.on('disconnect', function(){
  	  sys.puts(client.sessionId + " has disconnected.");
  	  redisClient.hget("sockets", client.sessionId, function(e, userId) {
  	    redisClient.hmget("users:" + userId, "name", "room", function(e, userInfo) {
  	      if (!userInfo || userInfo.length < 2) {
  	        sys.puts("got insufficient userinfo when disconnecting.");
  	        return false;
  	      }
  	      
  	      var name = userInfo[0].toString('utf8');
  	      var roomId = userInfo[1].toString('utf8');
  	      var websocketId = websocketId ? websocketId : client.sessionId;
  	      
  	      sys.puts(name + " has disconnected from room: " + roomId);
  	      
  	      redisClient.lrange(roomId + "/users", 0, 10, function(e, whiteList) {
  	        whiteList = whiteList? whiteList.toString().split(",") : [];
  	        whiteList = _.without(whiteList, websocketId);
  	        
  	        client.broadcastOnly(json({ announcement: + name + ' has dddddisconnected' }), whiteList);
  	          //remove this user from any lists of users
        		  redisClient.hdel("socket:" + client.sessionId, "room", function(e, result){});
        		  //remove from list (roomId + "/users")
        		  
      	  });
	      });
	    });
    });
  });
}

var tryStart = function() {
  if (gh.server == null) {
    sys.log("gh not started yet, waiting for nextTick to start socket server.");
    
    //would probably be more effective to just listen for an event that GH could emit when it's done starting up
    return process.nextTick(tryStart);
  }
  StartSocket();
}

tryStart();