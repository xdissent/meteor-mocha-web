var Mocha = Npm.require("mocha");
var Fiber = Npm.require("fibers");
var fs = Npm.require("fs");
var _ = Npm.require("underscore");
chai = Npm.require("chai");

var readFile = Meteor._wrapAsync(fs.readFile);

//basically a direct copy from meteor/packages/meteor/dynamics_nodejs.js
//except the wrapped function has an argument (mocha distinguishes
//asynchronous tests from synchronous ones by the "length" of the
//function passed into it, before, etc.)
var moddedBindEnvironment = function (func, onException, _this) {
  if (!Fiber.current)
    throw new Error(noFiberMessage);

  var boundValues = _.clone(Fiber.current._meteor_dynamics || []);

  if (!onException || typeof(onException) === 'string') {
    var description = onException || "callback of async function";
    onException = function (error) {
      Meteor._debug(
        "Exception in " + description + ":",
        error && error.stack || error
      );
    };
  }

  //note the callback variable present here
  return function (callback) {
    var args = _.toArray(arguments);

    var runWithEnvironment = function () {
      var savedValues = Fiber.current._meteor_dynamics;
      try {
        // Need to clone boundValues in case two fibers invoke this
        // function at the same time
        Fiber.current._meteor_dynamics = _.clone(boundValues);
        var ret = func.apply(_this, args);
      } catch (e) {
        onException(e);
      } finally {
        Fiber.current._meteor_dynamics = savedValues;
      }
      return ret;
    };

    if (Fiber.current)
      return runWithEnvironment();
    Fiber(runWithEnvironment).run();
  };
};

var Base = Npm.require("mocha/lib/reporters").Base;

function MeteorCollectionTestReporter(runner){
  Base.call(this, runner);
  var self = this;

  function saveTestResult(test){
    // console.log("TEST", test)
    Velocity.postResult({
      id: Meteor.uuid(),
      name: test.title,
      framework: "mocha-web",
      result: test.state
    });
  }

  runner.on("start", Meteor.bindEnvironment(
    function(){
      //TODO tell testRunner that mocha tests have started
    },
    function(err){
      throw err;
    }
  ));

  ["pass", "fail", "pending"].forEach(function(testEvent){
    runner.on(testEvent, Meteor.bindEnvironment(
      function(test){
        saveTestResult(test);
      },
      function(err){
        throw err;
      }
    ));
  });

  runner.on('end', Meteor.bindEnvironment(function(){
    //TODO tell testRunner all mocha web tests have finished
  }, function(err){
    throw err;
  }));
}


var mochaExports = {};
//this line retrieves the describe, it, etc. functions and puts them
//into mochaExports (mochaExports = {it: func, desc: func,...})
mocha = new Mocha({ui: "bdd", reporter: MeteorCollectionTestReporter});
mocha.suite.emit("pre-require", mochaExports);
//console.log(mochaExports);

//patch up describe function so it plays nice w/ fibers
describe = function (name, func){
  mochaExports.describe(name, Meteor.bindEnvironment(func, function(err){throw err; }));
};

//In Meteor, these blocks will all be invoking Meteor code and must
//run within a fiber. We must therefore wrap each with something like
//bindEnvironment. The function passed off to mocha must have length
//greater than zero if we want mocha to run it asynchronously. That's
//why it uses the moddedBindEnivronment function described above instead

//We're actually having mocha run all tests asynchronously. This
//is because mocha cannot tell when a synchronous fiber test has
//finished, because the test runner runs outside a fiber.

//It is possible that the mocha test runner could be run from within a
//fiber, but it was unclear to me how that could be done without
//forking mocha itself.


global['it'] = function (name, func){
  wrappedFunc = function(callback){
    if (func.length == 0){
      func();
      callback();
    }
    else {
      func(callback);
    }
  }

  boundWrappedFunction = moddedBindEnvironment(wrappedFunc, function(err){
    throw err;
  });

  mochaExports['it'](name, boundWrappedFunction);
};

["before", "beforeEach", "after", "afterEach"].forEach(function(testFunctionName){
  global[testFunctionName] = function (func){
    wrappedFunc = function(callback){
      if (func.length == 0){
        func();
        callback();
      }
      else {
        func(callback);
      }
    }

    boundWrappedFunction = moddedBindEnvironment(wrappedFunc, function(err){
      throw err;
    });

    mochaExports[testFunctionName](boundWrappedFunction);
  }
});

var testTimeout = null;

function evalTests(){
  Velocity.resetReports({framework: "mocha-web"});
  if (testTimeout){
    Meteor.clearTimeout(testTimeout);
  }
  //HACK a timeout shouldn't be necessary here
  testTimeout = Meteor.setTimeout(function(){
    //feel like i shouldn't have to do this..
    Meteor.clearTimeout(testTimeout);
    var testFiles = VelocityTestFiles.find({targetFramework: {$in: ["mocha-web"]}});
    testFiles.forEach(function(testFile){
      if (/\.js$/.exec(testFile.absolutePath)){
        // console.log("executing test file", testFile.absolutePath)
        var contents = readFile(testFile.absolutePath, "utf-8");
        eval(contents);
      }
      else {
//        console.log("ignoring non-javascript file", testFile.absolutePath);
      }
   });
   mocha.run(function(){
     //create a new 'mocha' so tests aren't run twice
     mocha = new Mocha({ui: "bdd", reporter: MeteorCollectionTestReporter});
     mocha.suite.emit("pre-require", mochaExports);
   });
  }, 500);
}

Velocity.registerFramework('mocha-web', evalTests);
