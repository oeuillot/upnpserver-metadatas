const commander = require('commander');
const debug = require('debug')('scanner');
const Scanner = require('./scanner');

commander.option("--progress", "Show download progress");

Scanner.configureCommander(commander);

commander.command('run').action((path) => {
  var scanner = new Scanner(commander);
  
  scanner.start(path);
  //var allocine = new Allocine(commander, path);
  
});

commander.parse(process.argv);
