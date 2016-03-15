/*jslint node: true, nomen: true, esversion: 6 */
"use strict";

const debug = require('debug')('scanner:tmdb');
const request = require('request');
const async = require('async');
const fs = require('fs');
const Path = require('path');
const util = require('util');

const METAS_DIR_FOLDER_NAME=".metas.dir";

class Tmdb {
  constructor(configuration) {
    this._configuration=configuration;

    this._loadedImages={}

    this._lastRun = 0;
    this.callQueue=async.queue((task, callback) => {
      //debug("Process new task");

      var now=Date.now();
      var dt=now-this._lastRun;
      if (dt>300) {
        this._lastRun=now;
        return task(callback);
      }
      debug("Wait",dt,"ms for next request");

      setTimeout(() => {
        this._lastRun=Date.now();
        task(callback);
      }, dt);      
    }, 1);

    this.movieDB=require('moviedb')(configuration.tmdbApiKey);
  }

  static configureCommander(commander) {
    commander.option("--tmdbApiKey <ApiKey>", "The movie database API key.");
  }

  _initialize(callback) {
    if (this._tmdbConfiguration) {
      return callback();
    }      

    this.callQueue.push((callback) => {
      if (this._tmdbConfiguration) {
        return callback();
      }      

      this.movieDB.configuration((error, configuration) => {
        if (error) {
          return callback(error);
        }

        debug("_initialize", "tmdb configuration loaded !", configuration);

        this._tmdbConfiguration=configuration;
        callback();        
      });
    }, callback);
  }

  sync(json, path, callback) {
    if (!json.type) {
      debug("Type not defined !", json)
      return callback();
    }

    this._initialize((error) => {
      if (error) {
        return callback(error);
      }

      switch(json.type) {
      case "tv":
        this.syncTV(json, path, (error) => {
          if (error) {
            return callback(error);
          }

          if (!json.tvInfo || !json.tvInfo.seasons) {
            return callback();
          }

          async.each(json.tvInfo.seasons, (season, callback) => {
            this.syncSeason(json, season, path, callback);  
          }, callback);          
        });
        return;
      }

      callback(new Error("Unsupported json type '"+json.type+"'"));
    });
  }

  syncTV(json, tvPath, callback) {    
    var tasks=[];
    if (this._configuration.progress) {
      console.log("Sync",json.name,"                                \r");
    }

    if (!json.key) {
      var name=Path.basename(tvPath);

      this.callQueue.push((callback) => {

        this.movieDB.searchTv({ query: name}, (error, res) => {
//          console.log(res);

          if (res.total_results===1) {
            json.key = res.results[0].id;

          } else if (res.total_results>1) {
            var r = res.results.find(
                (r) => (r.name.toLowerCase()===name.toLowerCase() || r.original_name.toLowerCase()===name.toLowerCase()));
            if (r) {
              json.key = r.id;
            }
          }

          callback(error);
        });
      }, (error) => {
        if (error) {
          return callback(error);
        }

        if (json.key) {          
          return this.syncTV(json, tvPath, callback);
        }

        callback();
      });
      return;
    }


    json.tvInfo = json.tvInfo || {};
    var tvInfo = json.tvInfo;

    var p={id: json.key, language: 'fr'};
    if (tvInfo.$timestamp) {
      p.ifModifiedSince = new Date(tvInfo.$timestamp);
    }
    if (tvInfo.$etag) {
      p.ifNoneMatch = tvInfo.$etag;
    }

    // var old=JSON.stringify(tvInfo);

    this.callQueue.push((callback) => {

      this.movieDB.tvInfo(p, (error, infos, req) => {
        if (error) {
          console.error(error);
          return callback(error);
        }

        if (req && req.header.etag) {
          if (tvInfo.$etag===req.header.etag) {
            debug("TvInfos has same etag !");
            return callback();
          }

          tvInfo.$etag= req.header.etag;         
        } else {
          delete tvInfo.$etag;
        }
        tvInfo.$timestamp = (new Date()).toUTCString();

        for(var k in infos) {
          tvInfo[k]=infos[k];
        }

        if (infos.backdrop_path) {
          tasks.push((callback) => this.copyImage(tvInfo, "backdrop_path", tvPath, callback));
        }
        if (infos.created_by) {
          infos.created_by.forEach((creator) => {
            tasks.push((callback) => this.copyImage(creator, "profile_path", tvPath, callback));
          });
        }
        if (infos.poster_path) {
          tasks.push((callback) => this.copyImage(tvInfo, "poster_path", tvPath, callback));
        }
        if (infos.seasons) {
          infos.seasons.forEach((season) => {
            tasks.push((callback) => this.copyImage(season, "poster_path", tvPath, callback));
          });
        }

        callback();
      });
    }, (error) => {
      if (error) {
        return callback(error);
      }

      async.series(tasks, callback);
    });
  }

  syncSeason(json, season, tvPath, callback) {
    var tasks=[];
    if (this._configuration.progress) {
      console.log("Sync",json.name,"Season",season.id,"                     \r");
    }

    var p={id: json.key, season_number: season.season_number, language: 'fr' };
    if (season.$timestamp) {
      p.ifModifiedSince = new Date(season.$timestamp);
    }
    if (season.$etag) {
      p.ifNoneMatch = season.$etag;
    }

//  console.log("S=",season);
    this.callQueue.push((callback) => {
      this.movieDB.tvSeasonInfo(p, (error, infos, req) => {
        if (error) {
          return callback(error);
        }

        if (req && req.header.etag) {
          if (season.$etag===req.header.etag) {
            debug("SAME ETAG ! (SEASON)");
            return callback();
          }

          season.$etag= req.header.etag;         
        } else {
          delete season.$etag;
        }
        season.$timestamp = (new Date()).toUTCString();

        // debug("Season Infos=",util.inspect(infos, {depth: null}));

        for(var k in infos) {
          season[k] = infos[k];
        }

        if (!season.production_code) {
          delete season.production_code;
        }
        
        if (season.poster_path) {
          tasks.push((callback) => this.copyImage(season, "poster_path", tvPath, callback));
        }

        infos.episodes.forEach((episode) => {
          // console.log("E=",episode);

          if (!episode.still_path) {
            delete episode.still_path;
          }
          if (!episode.production_code) {
            delete episode.production_code;
          }
          if (!episode.overview) {
            delete episode.overview;
          }

          if (episode.still_path) {
            tasks.push((callback) => this.copyImage(episode, "still_path", tvPath, callback));
          }
          if (episode.poster_path) {
            tasks.push((callback) => this.copyImage(episode, "poster_path", tvPath, callback));
          }

          (episode.crew || []).forEach((c) => {
            if (c.profile_path) {
              tasks.push((callback) => this.copyImage(c, "profile_path", tvPath, callback));
            }
            if (!c.profile_path) {
              delete c.profile_path;
            }
          });
          (episode.guest_stars || []).forEach((c) => {
            if (c.profile_path) {
              tasks.push((callback) => this.copyImage(c, "profile_path", tvPath, callback));
            }
            if (!c.profile_path) {
              delete c.profile_path;
            }
          });
        });

        callback();
      });
    }, (error) => {
      if (error) {
        return callback(error);
      }

      async.series(tasks, callback);
    });
  }

  copyImage(obj, fieldName, tvPath, callback) {
    if (!obj) {
      console.error("Obj associated to fieldname",fieldName," is null");
      return callback();
    }
    if (!obj[fieldName]) {
      console.error("Field",fieldName,"of object",obj,"is null");
      return callback();
    }
    
    var ov=obj[fieldName];
    if (ov.indexOf(METAS_DIR_FOLDER_NAME)===0) {
      ov=ov.substring(ov.indexOf('_')+1);
    }

    var p = ov.replace(/^\//, '');

    var lp = METAS_DIR_FOLDER_NAME + '/tmdb_'+p;
    obj[fieldName]= lp;

    if (this._loadedImages[p]) {
      return callback();
    }
    this._loadedImages[p]=true;

    debug("Copy image",p);

    var url=this._tmdbConfiguration.images.secure_base_url+"original/"+p; // +"?api_key="+this.movieDB.api_key;

    var metasDir=Path.join(tvPath, METAS_DIR_FOLDER_NAME);

//  debug("metasDir=",metasDir);

    fs.stat(metasDir, (error, stats) => {
      if (error) {
        fs.mkdir(metasDir, (error) => {
          if (error) {
            console.error("Can not create folder", metasDir, "error=",error);
            return callback(error);
          }

          return this.copyImage(obj, fieldName, tvPath, callback);
        });
        return;
      }

      var localPath = Path.join(metasDir, p);

      fs.stat(localPath, (error, localStats) => {
        if (!error && localStats.size>0 && !this.configuration.verifyImages) {
          return callback();
        }

        this.callQueue.push((callback) => {
          debug("Download image", url,"to", localPath);

          var options = {
              uri: url,
              headers: {}
          };

          if (localStats) {
            options.headers['If-Modified-Since']=localStats.mtime.toUTCString();
          }

          var stream = request.get(options);

          stream.on('response', (response) => {
            // console.log("Response=",response.headers)
            if (response.statusCode===200) {
              stream.pipe(fs.createWriteStream(localPath));              
              return;
            }
            if (response.statusCode===304) {
              debug("Image is not modified !");
              return;
            }

            console.error("StatusCode="+response.statusCode) // 200
            console.error("ContentType="+response.headers['content-type']) // 'image/png'
          });

          stream.on('end', () => {
//          debug("Download done !");
            callback();
          });
        }, callback);
      });
    });
  }

}

module.exports = Tmdb;