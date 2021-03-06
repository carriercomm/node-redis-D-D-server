var sys = require('sys'),
    app = _app,
    util = require('../../util/util'),
    errors = require('../../util/err'),
    client = require("redis").createClient(),
    errors = require('../../util/err'),
    cookie = require('cookie'),
    usersModel = require(__appRoot + "/app/models/user");

require("../../lib/uuid");
require("../../lib/underscore-min"); //exposed via _ obj


responses = {
  'idInactiveError' : "This session is not active right now.",
  'joinSuccess' : "",
  "noUserError" : "Client error: no user specified",
  'dbError' : "Database error."
}

function renderGameRoom(req, res, localVars) {
  
}

function getUsersForRoom(uuid, callback) {
  
}

function renderRoomWithPlayers(response, localVars, players, id, sessionId, thisUser, imageName) {
  localVars.players = players;
  localVars.display = responses['joinSuccess'];
  localVars.listenId = id;
  localVars.useDefault  = true; //use a default image for now, so this looks less broken when there is no map uploaded for a session
  localVars.websocketId = sessionId; //TODO: use this to dedupe websockets when someone joins a room in multiple tabs
  localVars.imageName = imageName;
  localVars.userName = thisUser;
  localVars.url = _url;
  localVars.isDM = false;
  localVars.isKnown = true;
  localVars.is_iPad = iPadUserAgent;
  
  var whichRoom = iPadUserAgent ? "room_mobile" : "room";

  response.render(whichRoom, {locals: localVars});
}

app.get("/join/:id", function(request, response) {
  var id = request.params.id,
      localVars = {};
      
  iPadUserAgent = request.header("user-agent").indexOf("iPad") > 0;
  
  function identifiedUserByCookie(result) {
    if (!result ||  !result.userName) {
      sys.puts("must be an unknown user");

      //TODO: might be nice to replace this with some flag on the page to indicate that we need to ask the user for their name first
      //this way we could support random users dropping in, without any registration

      //check room is active
      return client.lrange(id + "/users", 0, 10, function(userSockets) {
        var users = userSockets? userSockets.toString().split(",") : [];
        var totalUsers = users.length;

        if (!totalUsers || totalUsers <= 0) { //short circuit when this room has no one in it
          request.flash("message", "You should authenticate before trying that again.");
          return response.redirect("/account");
        }
        else {
          localVars.players = players;
          localVars.display = "Tell us your name and pick your poison.";
          localVars.listenId = id;
          localVars.useDefault  = true; //use a default image for now, so this looks less broken when there is no map uploaded for a session
          localVars.websocketId = sessionId;
          localVars.imageName = imageName;
          localVars.userName = thisUser;
          localVars.url = _url;
          localVars.isDM = true;
          localVars.isKnown = true;
          localVars.is_iPad = iPadUserAgent;
          
          var whichRoom = iPadUserAgent? "room_mobile" : "room"

          response.render(whichRoom, {locals: localVars});
        }
      });

    }

    sys.puts(result.defaultImage);
    sys.puts(result.userName);
    var thisUser = result.userName;
    var imageName = result.defaultImage;

    //TODO: I suspect this will not be common, but still a valid check. Should probably redirect to /accounts
    if (errors.isEmpty([thisUser, id, imageName])) {return response.send(responses['noUserError'])}

    //make sure this is an existing, active session
    client.hmget(id, "isActive", "owner", function(e, result) {
      sys.puts("looking at isActive, owner for room:" + id);
      if (e || !result) {return response.send(responses['idInactiveError']);}
      var isActive = util.hashResultMaybe(result, 0);
      if (!isActive) {return response.send(responses['idInactiveError']);}

      var owner = util.hashResultMaybe(result, 1);

      //the users: hash will hold all current users by websocketId, and a reference to the room they are currently in 
      client.hmset("users:" + sessionId, "room", id, "name", thisUser, "defaultImage", imageName, function(e, result) {
        sys.puts("set users: hash for sessionId: " + sessionId);
        if (e || !result) {return response.send(responses['dbError'])}

        //get a list of the existing usernames + images
        client.lrange(id + "/users", 0, 10, function(e, users) {
          users = users? users.toString().split(",") : [];
          var totalUsers = users.length;
          var thisPlayer = {name: thisUser, src: imageName}

          //don't let more than 10 people join a table
          if (totalUsers >= 10) {
            sys.puts("joined a full room, emiting canned response.");
            //return response.send("Sorry but this room is full.");
          }

          var players = [thisPlayer];

          if (users.length <= 0 || owner == thisUser) {
            localVars.players = players;
            localVars.display = responses['joinSuccess'];
            localVars.listenId = id;
            localVars.useDefault  = true; //use a default image for now, so this looks less broken when there is no map uploaded for a session
            localVars.websocketId = sessionId;
            localVars.imageName = imageName;
            localVars.userName = thisUser;
            localVars.url = _url;
            localVars.isDM = true;
            localVars.isKnown = true;
            localVars.is_iPad = iPadUserAgent;
            
            var whichRoom = iPadUserAgent ? "room_mobile" : "room";
            
            //get outta here!
            sys.puts("emitting good, valid response.");
            return response.render(whichRoom, {locals: localVars});
          }
          return renderRoomWithPlayers(response, localVars, [], id, sessionId, thisUser, imageName);
          //user is not DM, we need to set this up so they can see other users
          //might be possible to push this off to an API call later
          _.each(users, function(socketid, index) {
            //get info from redis
            client.hget("sockets", socketid, function(e, userId) {
              
              var fetchThisUser = function(userId) {
                client.hmget("users:" + userId, "name", "defaultImage", function(e, result) {
                  
                  result = result? result.toString().split(",") : [];
                  var userName = result[0];
                  var imageSrc = result[1];
                  
                  if (e || !result || result.length < 2 || (!userName || !imageSrc)) {
                    sys.puts("got no result for hmget users:" + userId + " will attempt on next process tick.");
                    totalUsers--;
                    
                    return totalUsers <= 0? renderRoomWithPlayers(response, localVars, players, id, sessionId, thisUser, imageName) : false;
                  }
                  
                  totalUsers--;
                  userName = userName? userName.toString('utf8') : "some user";//that is kind of a weird way to fail
                  imageSrc = imageSrc? imageSrc.toString('utf8') : "/res/img/Tokens.png";
                  if (!imageSrc.match("/res/img/")) {imageSrc = "/res/img/" + imageSrc + ".png";}
                  
                  sys.puts("identified : " + userName + " with image: " + imageSrc + " " + totalUsers + " remaining to lookup.");
                  
                  var isDuplicate = false;
                  _.each(players, function(playerObj, key, list) {
                    if (playerObj.name == userName) {
                      isDuplicate = true;
                      return false;
                    }
                  });

                  if (!isDuplicate) {
                    var thisPlayer = {name: userName, src: imageSrc};
                    players.push(thisPlayer);
                  }

                  if (totalUsers <= 0) {
                    return renderRoomWithPlayers(response, localVars, players, id, sessionId, thisUser, imageName);

                  };
                });
              }
              fetchThisUser(userId);
            });
          });
        });
      });

    });
  }
  
  //get the ID for their session variables
  var sessionId = request.getCookie("uid");  
  sys.puts("user with cookie:" + sessionId + " attempting to join room:" + id);
  
  //get user session data TODO: replace this with users.getUserByCookieId
  return usersModel.getUserByCookieId(sessionId, identifiedUserByCookie);
});