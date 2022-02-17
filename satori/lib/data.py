'''
the DataManager object could even run as a separate server.
it should be as light weight as possible, handling data streams and their
updates constantly. any downtime it has should be spent aggregating new
datasets that might be of use to the Modelers. It does not evaluate them using
the predictive power score, but could access the global map of publishers and
their subscribers on chain, thereby acting as a low-computation recommender
system for the Modelers since it doesn't actually compute any scores. The
DataManager needs lots of disk space, both ram and short term memory. It also
needs high bandwidth capacity. If it serves only one modeler it need not be
separate from the modeler, but if it serves many, it should be on its own
hardware.

Basic Reponsibilities of the DataManager:
1. listen for new datapoints on all datastreams used by ModelManagers
    A. download and save new datapoints
    B. notify relevant ModelManagers new data is available (see 2.)
2. produce a query whereby to pull data for each model from disk.
    A. list the datasets to pull
    B. for each dataset list the columns
    C. filter by recent data (model managers can add this part if they want)
3. search for useful data streams
    A. generate a map of all pub sub relationships from the chain
    B. find similar subscribers: compare the model manager's inputs to other
       subscribers inputs
    C. find a likely group of useful publishers: of all the similar subscribers
       (by input) what group of publishers (by input or metadata) do they
       subscribe to that this model manager does not?
    D. find a unique datastream in the group: one that few or zero similar
       subscriber subscribe to
    E. download the datastream and notify model manager
4. garbage collect stale datastreams
'''

import pandas as pd

class DataManager:

    def __init__(
        self,
        dataPath:str='data.parquet',
        data:pd.DataFrame=pd.DataFrame(),
        getData:'function'=None,
        validateData:'function'=None,
        appendData:'function'=None,
    ):
        self.dataPath = dataPath
        self.dataOriginal = data
        self.data = data
        self.everything = {}  # a set of all the column names (stream ids) I've seen before.
        self.resetIncremental()
        self.getData = getData or DataManager.defaultGetData
        self.validateData = validateData or DataManager.defaultValidateData
        self.appendData = appendData or DataManager.defaultAppendData
        self.run()

    def defaultGetData() -> pd.DataFrame:
        return pd.DataFrame({'a': [1]})  # rest call or something

    def defaultValidateData(
        data:pd.DataFrame,
        existing:pd.DataFrame,
        resetIndex=True,
    ) -> bool:
        ''' you may not want to reset index if it's a date you'd like to compare against '''
        def lastRow():
            if resetIndex:
                return existing.iloc[-1:,:].reset_index(drop=True)
            return existing.iloc[-1:,:]

        if (
            data.empty
            or not (0 < data.iloc[0,0] < 2) or not (0 < data.iloc[0,0] < 2) or not (0 < data.iloc[0,0] < 2)
            or lastRow().equals(data)  # perhaps you're calling before the data has changed...
        ):
            return False
        return True

    def defaultAppend(
        data:pd.DataFrame,
        existing:pd.DataFrame,
        resetIndex=True,
    ) -> pd.DataFrame:
        ''' you may not want to reset index if it's a date you'd like to compare against '''
        x = existing.append(data)
        if resetIndex:
            return x.reset_index(drop=True)
        return x

    def resetIncremental(self):
        self.incremental = pd.DataFrame(columns=self.data.columns)

    def importance(self, inputs:dict = None):
        inputs = inputs or {}
        totaled = {}
        for importances in inputs.values():
            for k, v in importances.items():
                totaled[k] = v + totaled.get(k, 0)
        self.imports = sorted(totaled.items(), key=lambda item: item[1])

    def showImportance(self):
        return [i[0] for i in self.imports]

    def get(self):
        ''' gets the latest update for the data '''
        self.getOriginal()
        self.getExploratory()
        self.getPurge()

    def getOriginal(self):
        ''' gets the latest update for the data '''
        self.incremental = self.getData()

    def getExploratory(self):
        '''
        asks an endpoint for the history of an unseen datastream.
        provides showImportance and everythingSeenBefore perhaps...
        scores each history against each of my original data columns
        Highest are kept, else forgotten (not included in everything)
        a 'timer' is started for each that is kept so we know when to
        purge them if not picked up by our models, so the models need
        a mechanism to recognize new stuff and test it out as soon as
        they see it.
        '''
        pass

    def getPurge(self):
        ''' in charge of removing columns that aren't useful to our models '''
        pass

    def validate(self) -> bool:
        ''' appends the latest change to data '''
        if self.validateData(self.incremental, self.data):
            return True
        self.resetIncremental()
        return False

    def append(self):
        ''' appends the latest change to data '''
        self.data = self.appendData(self.incremental, self.data)
        self.resetIncremental()

    def save(self):
        ''' gets the latest update for the data '''
        self.data.to_parquet(self.dataPath)

    def run(self, inputs:dict = None) -> bool:
        ''' runs all three steps '''
        self.importance(inputs)
        self.get()
        if self.validate():
            self.append()
            self.save()
            return True
        return False

    def runOnce(self, inputs:dict = None) -> bool:
        ''' run denotes a loop, there's no loop but now its explicit '''
        return self.run(inputs)