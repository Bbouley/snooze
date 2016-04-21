var app         = require('express')();
var forever     = require('forever');
var bodyParser  = require("body-parser");
var cookieParser = require('cookie-parser');
var urlHelper   = require('url');
var _           = require('underscore');
var guid        = require('guid');
var jwt         = require('jsonwebtoken');
var bbJWT       = require("bbjwt-client");

var AWS         = require('aws-sdk');
var crypto      = require('crypto');

var logger      = require('./util/logger');
var sdc         = require('./util/metrics');

var snsMap      = require('./core/snsMap');
var tasks       = require('./core/tasks');

var runner      = require('./core/runner');

//var SERVERID = uuid.v4();

process.on('uncaughtException',function(err){
    try
    {
        logger.logError('uncaughtException: '+err.message,err.stack);
    }
    catch (e)
    {
        console.log('uncaughtException: '+err.message,err.stack);
    }
    //process.exit(1);
});


app.listen(process.env.IP_ADDRESS || 80);

app.enable('trust proxy');
app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({limit: '50mb'}));
app.use(cookieParser());
app.use(function (req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,BB-JWT');
    res.setHeader('Access-Control-Allow-Credentials', true);
    next();
});

app.get('/', function (req, res, next) {
    returnSuccess(res,'Snooze is up.');
});

app.post('/snsTarget', function(req, res, next){

    authenticate(req, res, function(jwt){
        snsMap.addTarget(req.body,function(err,taskInfo){
            if (err)
            {
                returnErrorJson(res, 'Error adding target; '+err);
            }
            else
            {
                returnSuccessJson(res, {message: 'SNS Target Added for '+taskInfo.taskType });
            }
        });
    });

});

app.get('/snsTarget/:taskType', function(req, res, next){

    authenticate(req, res, function(jwt) {
        snsMap.getTarget(req.params.taskType,function(err,snsTargets){
            if (err)
            {
                returnErrorJson(res, 'Error occurred retrieving snsTargets; '+err);
            }
            else
            {
                returnSuccessJson(res, snsTargets);
            }
        });
    });

});

app.post('/add', function (req, res, next) {

    var task = req.body.task;
    var isJSON = function(str) {
        try {
            JSON.parse(str);
        } catch (e) {
            return false;
        }
        return true;
    };

    var addTask = function(task) {
        tasks.checkForDuplicateRefId(task.refId, function(err, exists) {
            if (err)
            {
                returnErrorJson(res, err);
            }
            else
            {
                tasks.addTask(task,function(err,taskId){
                    if (err)
                    {
                        logger.logError('Error occurred adding a task: '+err,task);
                        sdc.incrMetric('addTaskError');
                        returnErrorJson(res, err);
                    }
                    else
                    {
                        sdc.incrMetric('addTaskSuccess');
                        returnSuccessJson(res, { id: taskId, success: true, message: 'Task added' });
                    }

                });
            }
        });
    };

    authenticate(req, res, function(jwt){

        // check requirements for adding a thing
        if (task && (typeof task == 'object' || (typeof task == 'string' && isJSON(task)) ))
        {

            if (typeof task == 'string')
            {
                task = JSON.parse(task);
            }

            if (task.snsTask)
            {
                snsMap.getTarget(task.snsTask,function(err,taskInfo){
                    task = _.extend(task,{ snsTarget: taskInfo.snsTarget });
                    delete task.snsTask;
                    addTask(task);
                });
            }
            else
            {
                addTask(task);
            }

        }
        else
        {
            returnError(res, 'no task specified, or not a valid object?!');
        }

    });

});

app.put('/cancel/:id', function (req, res, next) {

    tasks.getTask(req.params.id, function(err, data) {
        if (err)
        {
            returnErrorJson(res, 'Error retrieving from DB');
        }
        else
        {
            if(!data)
            {
                returnErrorJson(res, 'Task does not exist');
            }
            else
            {
                tasks.setStatus(req.params.id, tasks.CANCELED, function (err, data) {
                    if (err)
                    {
                        returnErrorJson(res, err);
                    }
                    else
                    {
                        returnSuccessJson(res, {task: data.Attributes, success: true, message: 'Task Status Updated'});
                    }
                });
            }
        }
    });
});

app.get('/is/:id', function(req, res, next) {

    tasks.getTask(req.params.id, function(err, data){
        if(err)
        {
            returnErrorJson(res, 'Error retrieving task')
        }
        else
        {
            if(!data)
            {
                returnErrorJson(res, 'Task does not exist');
            }
            else
            {
                returnSuccessJson(res, {task: data, success: true, message: 'Task Found'})
            }
        }
    });

});

app.get('/isbyref/:refid', function(req, res, next) {

    tasks.getTaskByRef(req.params.refid, function(err, data){
        if(err)
        {
            returnErrorJson(res, 'Error retrieving task')
        }
        else
        {
            try
            {
                if(data.Items.length === 0)
                {
                    returnNotFound(res, 'Task does not exist');
                    res.status(404)
                }
                else
                {
                    returnSuccessJson(res, {task: data.Items[0], success: true, message: 'Task Found'})
                }
            }
            catch (e)
            {
                returnErrorJson(res, e.message);
            }

        }
    });

});

app.get('/health-check', function(req, res, next) {

    if(child)
    {
        returnSuccessJson(res, {message : 'Snooze is happy, Runner is up'});
    }
    else
    {
        returnErrorJson(res, 'Snooze is sad, Runner is down right now');
    }

});

app.put('/task/:id', function(req, res, next) {

    var newTaskInfo = req.body.task;
    console.log('Task info being sent up : ', newTaskInfo);

    tasks.updateTask(req.params.id, newTaskInfo,function(err, data) {
        if(err)
        {
            returnErrorJson(res, 'Task not updated correctly');
        }
        else
        {
            returnSuccessJson(res, {task : data.Attributes, success: true, message: 'Task successfully Updated'});
        }

    });

});

function authenticate(req, res, callback)
{
    var decodedToken = '';
    if (process.env.JWT_HEADER)
    {
        var token = req.get(process.env.JWT_HEADER);
        decodedToken = bbJWT.decodeToken(token);
        var reqIP = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        if (decodedToken === false)
        {
            sdc.incrMetric('userAuthenticationFailed');
            returnError(res, 'Invalid JWT from '+reqIP);
            return;
        }
    }
    callback && callback(decodedToken);
}

function returnError(res,err)
{
    res.status(500).end('crap '+err);
}

function returnErrorJson(res,message,data)
{
    data = data || null;
    res.status(500).json({message : message, data:data, success: false});
}

function returnNotFound(res, message, data)
{
    data = data || null;
    res.status(404).json({ message : message, data : data, success : false})
}

function returnSuccess(res,msg)
{
    res.status(200).end(msg);
}

function returnSuccessJson(res,result)
{
    res.status(200).json(result);
}

/* start task runner process */

var child = new(forever.Forever)('core/runner.js', {
    max: 3,
    silent: true,
    args: []
});

child.on('start', runnerStarted);
child.on('exit', runnerExited);
child.start();

function runnerExited()
{
    console.log('Tell something that the main runner exited, please!');
}
function runnerStarted()
{
    console.log('Task Runner Started');
}

if (process.env.TEST_RUNNER)
{
    module.exports = { app: app, runner: child };
}

