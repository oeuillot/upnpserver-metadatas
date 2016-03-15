/*jslint node: true, nomen: true, esversion: 6 */
"use strict";

const fs = require('fs');
const Path = require('path');
const util = require('util');
const async = require('async');
const Tmdb = require('./tmdb');

const debug = require('debug')('scanner:tmdb');

class Scanner {
  constructor(configuration) {
    this._configuration=configuration;

    this._tmdb = new Tmdb(configuration);
  }
  
  static configureCommander(commander) {
    Tmdb.configureCommander(commander);

    commander.option("--forceTMDB <type>", "Force The movie database");
  }

  start(path) {
    debug("Scan path",path);

    fs.readdir(path, (error, list) => {
      async.each(list, (name, callback) => {
        debug("Scan child",name);
        var p=Path.join(path, name);

        fs.stat(p, (error, stats) => {
          if (error) {
            console.error("Can not stat",p);
            return callback();
          }
          if (!stats.isDirectory()) {
            return callback();
          }

          this._scanDirectory(p, callback);      
        });
      }, (error) => {
        if (error) {
          console.error("Process error",error);
          return;
        }

        console.log("DONE");        
      });
    });
  }

  _scanDirectory(path, callback) {

    var p2=Path.join(path, ".metas.json");

    fs.stat(p2, (error, stats2) => {
      if (error) {
        console.error("No metas.json");

        if (this._configuration.forceTMDB) {
          fs.writeFile(p2, "{}", (error) => {
            if (error) {
              return callback(error);
            }

            this._scanDirectory(path, callback);
          });
          return;
        }
        
        return callback();
      }

      //debug("Stat of",p2,"=>",stats2);

      fs.readFile(p2, { encoding: 'utf-8'}, (error, content) => {
        if (error) {
          console.error("Can not load content",error);
          return callback();
        }

        //debug("Load",p2,"=>",content);

        var json=JSON.parse(content);

        var tasks=[];

        var thm=json['themoviedb.org'];
        if (!thm && this._configuration.forceTMDB) {
          thm={ type: this._configuration.forceTMDB};
          json['themoviedb.org']=thm;
        }
        if (thm) {
          tasks.push((callback) => this._tmdb.sync(thm, path, (error, modified2) => {
            callback(error);
          }));
        }

        var allo=json['allocine.fr'];
        if (allo) {
          tasks.push((callback) => this._allocine.sync(allo, path, (error, modified2) => {
            modified |= modified2;

            callback(error);
          }));            
        }

        async.parallel(tasks, (error) => {
          if (error) {
            return callback(error);
          }

          var newJSON=JSON.stringify(json, null, 2);

          if (content===newJSON) {
            debug("Same JSON, don't write !");
            return callback();
          }
          debug("Not same JSON, write file",p2);
          json.timestamp=(new Date()).toUTCString();

          newJSON = JSON.stringify(json, null, 2);

          fs.writeFile(p2, newJSON, { encoding: 'utf-8'}, callback);
        });
      });
    });
  }
}

module.exports = Scanner;