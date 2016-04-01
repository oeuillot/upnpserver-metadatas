/*jslint node: true, nomen: true, esversion: 6 */
"use strict";

const debug = require('debug')('scanner:tmdb');
const request = require('request');
const async = require('async');
const fs = require('fs');
const Path = require('path');
const util = require('util');

const METAS_DIR = ".metadatas";

const IMAGE_LANGUAGES="fr,en,null";

class Tmdb {
  constructor(configuration) {
    this._configuration=configuration;

    this._loadedImages={};

    this._lastRun = Date.now();
    this._remaining=30;
    
    var self=this;
    function next(task, callback) {
      //debug("Process new task");

      var now=Date.now();

      var r=self._remaining+Math.floor((now-self._lastRun)/333);      
      if (r<=5) {
        //debug("Wait",400,"ms for next request remaining=",r);

        setTimeout(() => {
          next(task, callback);
        }, 400);
        return;
      }
       
//      console.log("r=",r);
      
      self._remaining--;
      self._lastRun=Date.now();
      task(callback);
    }
    this.callQueue=async.queue(next, 4);

    this.movieDB=require('moviedb')(configuration.tmdbApiKey);
  }

  _nextRequest(request) {
    var remaining = request.headers['x-ratelimit-remaining'];
    if (remaining===undefined) {
      return;
    }

    this._remaining=parseInt(remaining, 10);
    this._lastRun=Date.now();
//    console.log("Remaining=",this._remaining);
  }

  static configureCommander(commander) {
    commander.option("--tmdbApiKey <ApiKey>", "The movie database API key.");
    commander.option("--ignoreETAG", "Ignore Etag");
    commander.option("--resetTMDB", "Clear The movie database meta");
  }

  _initialize(callback) {
    if (this._tmdbConfiguration) {
      return callback();
    }      

    this.callQueue.push((callback) => {
      if (this._tmdbConfiguration) {
        return callback();
      }      

      this.movieDB.configuration((error, configuration, req) => {
        if (error) {
          return callback(error);
        }
        this._nextRequest(req);

        debug("_initialize", "tmdb configuration loaded !", configuration);

        this._tmdbConfiguration=configuration;
        callback();        
      });
    }, callback);
  }

  sync(json, path, callback) {
    if (!json.type) {
      debug("Type not defined !", json);
      return callback();
    }

    if (this._configuration.resetTMDB) {
      json.tvInfo={};
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
    if (this._configuration.progress) {
      process.stdout.write("Sync tv="+(json.name || Path.basename(tvPath))+"                                \r");
    }

    if (!json.key) {
      var name=Path.basename(tvPath);

      this.callQueue.push((callback) => {

        this.movieDB.searchTv({ query: name}, (error, res, req) => {
          if (error) {
            return callback(error);
          }
//        console.log(res);
          this._nextRequest(req);

          if (res.total_results===1) {
            json.key = res.results[0].id;

          } else if (res.total_results>1) {
            var r = res.results.find(
                (r) => (r.name.toLowerCase()===name.toLowerCase() || r.original_name.toLowerCase()===name.toLowerCase()));
            if (r) {
              json.key = r.id;
            }
          }

          if (!json.key) {
            console.error("Can not identify tv='"+name+"'");
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

    var p2={id: json.key, language: 'fr'};

    // var old=JSON.stringify(tvInfo);

    async.series([(callback) => {
      var tasks=[];

      this.callQueue.push((callback) => {
        var p=Object.assign({}, p2);

        if (tvInfo.$timestamp) {
          p.ifModifiedSince = new Date(tvInfo.$timestamp);
        }
        if (tvInfo.$etag && !this._configuration.ignoreETAG) {
          p.ifNoneMatch = tvInfo.$etag;
        }

        this.movieDB.tvInfo(p, (error, infos, req) => {
          if (error) {
            console.error(error);
            return callback(error);
          }
          this._nextRequest(req);

          if (req && req.header.etag) {
            if (tvInfo.$etag===req.header.etag && !this._configuration.ignoreETAG) {
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

          if (tvInfo.backdrop_path) {
            delete tvInfo.backdrop_path;
            //tasks.push((callback) => this.copyImage(tvInfo, "backdrop_path", tvPath, callback));
          }
          if (infos.created_by) {
            infos.created_by.forEach((creator) => {
              if (creator.profile_path) {
                tasks.push((callback) => this.copyImage(creator.profile_path, tvPath, callback));
              }
            });
          }
          if (tvInfo.poster_path) {
            delete tvInfo.poster_path;
            //tasks.push((callback) => this.copyImage(tvInfo, "poster_path", tvPath, callback));
          }
          if (infos.seasons) {
//            infos.seasons.forEach((season) => {
//              tasks.push((callback) => this.copyImage(season, "poster_path", tvPath, callback));
//            });
          }

          callback();
        });
      }, (error) => {
        if (error) {
          return callback(error);
        }

        async.series(tasks, callback);
      });
    }, (callback) => {     
      var tasks=[];

      this.callQueue.push((callback) => {
        var p=Object.assign({}, p2);
        p.include_image_language=IMAGE_LANGUAGES;
        
        if (tvInfo.$imagesTimestamp) {
          p.ifModifiedSince = new Date(tvInfo.$imagesTimestamp);
        }
        if (tvInfo.$imagesEtag && !this._configuration.ignoreETAG) {
          p.ifNoneMatch = tvInfo.$imagesEtag;
        }

        this.movieDB.tvImages(p, (error, infos, req) => {
          if (error) {
            console.error(error);
            return callback(error);
          }
          this._nextRequest(req);

          if (req && req.header.etag) {
            if (tvInfo.$imagesEtag===req.header.etag && !this._configuration.ignoreETAG) {
              debug("TvImages has same etag !");
              return callback();
            }

            tvInfo.$imagesEtag= req.header.etag;         
          } else {
            delete tvInfo.$imagesEtag;
          }
          tvInfo.$imagesTimestamp = (new Date()).toUTCString();

          console.log("TvImages=",json.key, infos);

          var idx;
          if (infos.posters && infos.posters.length) {
            idx=0;
            tvInfo.posters=infos.posters.map((poster) => {     
              var ix=idx++;

              if (!ix) {
                tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
              }
              
              return {path: poster.file_path, width: poster.width, height: poster.height };
            });
          }

          if (infos.backdrops && infos.backdrops.length) {
            idx=0;
            tvInfo.backdrops=infos.backdrops.map((poster) => {     
              var ix=idx++;

              if (!ix) {
                tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
              }
              
              return {path: poster.file_path, width: poster.width, height: poster.height };
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

    }], callback);
  }

  syncSeason(json, season, tvPath, callback) {
    if (this._configuration.progress) {
      process.stdout.write("Sync tv="+json.tvInfo.name+" season #"+season.season_number+"                     \r");
    }

    var p2={id: json.key, season_number: season.season_number, language: 'fr' };

//  console.log("S=",season);
    async.series([(callback)=> {
      var tasks=[];

      this.callQueue.push((callback) => {
        var p=Object.assign({}, p2);

        if (season.$timestamp) {
          p.ifModifiedSince = new Date(season.$timestamp);
        }
        if (season.$etag && !this._configuration.ignoreETAG) {
          p.ifNoneMatch = season.$etag;
        }

        this.movieDB.tvSeasonInfo(p, (error, infos, req) => {
          if (error) {
            return callback(error);
          }
          this._nextRequest(req);

          if (req && req.header.etag) {
            if (season.$etag===req.header.etag && !this._configuration.ignoreETAG) {
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
          if (!season.overview) {
            delete season.overview;
          }

          if (season.poster_path) {
            delete season.poster_path;
            //tasks.push((callback) => this.copyImage(season.poster_path, tvPath, callback));
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
            if (episode.crew && !episode.crew.length) {
              delete episode.crew;
            }
            if (episode.guest_stars && !episode.guest_stars.length) {
              delete episode.guest_stars;
            }

            if (episode.still_path) {
              //delete episode.still_path;
              //tasks.push((callback) => this.copyImage(episode, "still_path", tvPath, callback));
            }
            if (episode.poster_path) {
              //delete episode.poster_path;
              //tasks.push((callback) => this.copyImage(episode, "poster_path", tvPath, callback));
            }

            (episode.crew || []).forEach((c) => {
              if (c.profile_path) {
                //tasks.push((callback) => this.copyImage(c.profile_path, tvPath, callback));
              }
              if (!c.profile_path) {
                delete c.profile_path;
              }
            });
            (episode.guest_stars || []).forEach((c) => {
              if (c.profile_path) {
                //tasks.push((callback) => this.copyImage(c.profile_path, tvPath, callback));
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
    }, (callback) => {
    
      var tasks=[];

      this.callQueue.push((callback) => {
        var p=Object.assign({}, p2);
        p.include_image_language=IMAGE_LANGUAGES;

        if (season.$imagesTimestamp) {
          p.ifModifiedSince = new Date(season.$imagesTimestamp);
        }

        if (season.$imagesEtag && !this._configuration.ignoreETAG) {
          p.ifNoneMatch = season.$imagesEtag;
        }

        this.movieDB.tvSeasonImages(p, (error, infos, req) => {
          if (error) {
            console.error(error);
            return callback(error);
          }
          this._nextRequest(req);

          if (req && req.header.etag) {
            if (season.$imagesEtag===req.header.etag && !this._configuration.ignoreETAG) {
              debug("SeasonImages has same etag !");
              return callback();
            }

            season.$imagesEtag= req.header.etag;         
          } else {
            delete season.$etag;
          }
          season.$imagesTimestamp = (new Date()).toUTCString();

          console.log("SeasonImages=",json.key,season.season_number,infos);

          var idx;
          if (infos.posters && infos.posters.length) {
            idx=0;
            season.posters = infos.posters.map((poster) => {
              var ix=idx++;

              if (!ix) {
                tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
              }
              
              return {path: poster.file_path, width: poster.width, height: poster.height };
            });
            
          } else if (season.poster_path) {
            console.error("********* SEASON POSTER_PATH ");
          }

          if (infos.backdrops && infos.backdrops.length) {
            idx=0;
            season.backdrops = infos.backdrops.map((poster) => {
              var ix=idx++;

              if (!ix) {
                tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
              }
              
              return {path: poster.file_path, width: poster.width, height: poster.height };
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

    }, (callback) => {

      async.each(season.episodes, (episode, callback) => {
        this.syncEpisode(json, episode, tvPath, callback);  
      }, callback);          

    }], callback);
  }

  syncEpisode(json, episode, tvPath, callback) {
    if (this._configuration.progress) {
      process.stdout.write("Sync tv="+json.tvInfo.name+" season #"+episode.season_number+" episode #"+episode.episode_number+"                    \r");
    }

    var p={id: json.key, season_number: episode.season_number, episode_number: episode.episode_number, language: 'fr' };
    p.include_image_language=IMAGE_LANGUAGES;

//  console.log("S=",season);
    var tasks=[];

    this.callQueue.push((callback) => {
      if (episode.$imagesTimestamp) {
        p.ifModifiedSince = new Date(episode.$imagesTimestamp);
      }
      if (episode.$imagesEtag && !this._configuration.ignoreETAG) {
        p.ifNoneMatch = episode.$imagesEtag;
      }

      this.movieDB.tvEpisodeImages(p, (error, infos, req) => {
        if (error) {
          return callback(error);
        }
        this._nextRequest(req);

        if (req && req.header.etag) {
          if (episode.$imagesEtag===req.header.etag && !this._configuration.ignoreETAG) {
            debug("SAME ETAG ! (EPISODE)");
            return callback();
          }

          episode.$imagesEtag= req.header.etag;         
        } else {
          delete episode.$imagesEtag;
        }
        episode.$imagesTimestamp = (new Date()).toUTCString();

        console.log("Episode Images=",json.key,episode.season_number,episode.episode_number, infos);

        var idx;
        if (infos.stills && infos.stills.length) {
          idx=0;
          episode.stills=infos.stills.map((poster) => {
            var ix=idx++;

            if (!ix) {
              tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
            }
            
            return {path: poster.file_path, width: poster.width, height: poster.height };
          });
        }
        if (infos.posters && infos.posters.length) {
          idx=0;
          episode.posters= infos.posters.map((poster) => {     
            var ix=idx++;

            if (!ix) {
              tasks.push((callback) => this.copyImage(poster.file_path, tvPath, callback));
            }
            
            return {path: poster.file_path, width: poster.width, height: poster.height };
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

  copyImage(ov, tvPath, callback) {
    if (!ov) {
      console.error("Path is null");
      return callback();
    }

    var p = ov.replace(/^\//, '');

    if (this._loadedImages[p]) {
      return callback();
    }
    this._loadedImages[p]=true;

    debug("Copy image",p);

    var url=this._tmdbConfiguration.images.secure_base_url+"original/"+p; // +"?api_key="+this.movieDB.api_key;

    var metasDir=Path.join(tvPath, METAS_DIR, "tmdb");

//  debug("metasDir=",metasDir);

    fs.mkdir(metasDir, (error) => {

      var localPath = Path.join(metasDir, p);

      fs.stat(localPath, (error, localStats) => {
        if (!error && localStats.size>0 && !this._configuration.verifyImages) {
          return callback();
        }

        if (this._configuration.progress) {
          process.stdout.write("GetImage name="+p+"                                          \r");
        }

        var loadImage = (callback) => {
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
            //console.log("ImageResponse=",response.headers);
            this._nextRequest(response);

            if (response.statusCode===200) {
              stream.pipe(fs.createWriteStream(localPath));              
              return;
            }
            if (response.statusCode===304) {
              debug("Image is not modified !");
              return;
            }

            console.error("StatusCode="+response.statusCode); // 200
            console.error("ContentType="+response.headers['content-type']); // 'image/png'
          });

          stream.on('end', () => {
            //          debug("Download done !");
            callback();
          });
        };

        if (false) {
          this.callQueue.push(loadImage, callback);
          return;
        }
        loadImage(callback);
      });
    });
  }
}

module.exports = Tmdb;