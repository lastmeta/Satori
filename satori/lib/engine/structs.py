import json
import pandas as pd 
import datetime as dt
from satori import config

class SourceStreamTargets:
    
    def __init__(
        self,
        stream:str,
        targets:list[str]=None,
        source:str=None,
    ):
        self.stream = stream
        self.targets = targets or [stream] 
        self.source = source or config.defaultSource

    def id(self):
        ''' id has one target '''
        return (self.source, self.stream, self.targets[0])

    def get(self):
        ''' easy to combine '''
        return (self.source, self.stream, self.targets)

    def asTuples(self):
        ''' easy to combine '''
        return [(self.source, self.stream, target) for target in self.targets]

    def asMap(self):
        ''' hard to combine '''
        return {self.source: {self.stream: self.targets}}

    def asDict(self):
        ''' hard to combine '''
        return {(self.source, self.stream): self.targets}
    
    @staticmethod
    def combine(sourceStreamTargetss:list['SourceStreamTargets']):
        ''' {('x', 'y', 'z1'), ('a', 'b', 'c'), ('x', 'y', 'z2')} '''
        return {(source, stream, targets) for sst in sourceStreamTargetss for source, stream, targets in sst.asTuples()}

    @staticmethod
    def condense(sourceStreamTargetss:list['SourceStreamTargets']):
        '''
        SourceStreamTargets.condense(targets)
        [('x', 'y', ['z1', 'z2']), ('a', 'b', ['c'])]
        '''
        existing = {}
        ret = []
        for sst in sourceStreamTargetss:
            if (sst.source, sst.stream) in existing.keys():
                existing[(sst.source, sst.stream)].extend(sst.targets)
                existing[(sst.source, sst.stream)].extend(sst.targets)
            else:
                existing = {**existing, **sst.asDict()}
        for key, value in existing.items():
            ret.append((key[0], key[1], list(set(value))))
        return ret
    
class PredictionMap(dict):
    def __init__(self, predictions:dict[str, str], source:str=None, stream:str=None):
        super(PredictionMap,self).__init__([
            ((source,stream,k),v)
            for k, v in predictions.items()
                                    ])
        self.itemlist = super(PredictionMap, self).keys()
    #def __setitem__(self, key, value):
    #    # TODO: what should happen to the order if
    #    #       the key is already in the dict       
    #    #self.itemlist.append(key)
    #    super(PredictionMap, self).__setitem__(key, value)
    #def __iter__(self):
    #    return iter(self.itemlist)
    #def keys(self):
    #    return self.itemlist
    #def values(self):
    #    return [self[key] for key in self]  
    #def itervalues(self):
    #    return (self[key] for key in self)
    def add(self, source, stream, target, prediction=None):
        return self.__setitem__((source, stream, target), prediction)

PredictionMap(source='a', stream='b', predictions={'c':'d','e':'f'})
x = PredictionMap(source='a', stream='b', predictions={'c':'d','e':'f'}) 
x.add('x', 'y', 'z', 0)  

class HyperParameter:
    
    def __init__(
        self,
        name:str='n_estimators',
        value=3,
        limit=1,
        minimum=1,
        maximum=10,
        kind:'type'=int
    ):
        self.name = name
        self.value = value
        self.test = value
        self.limit = limit
        self.min = minimum
        self.max = maximum
        self.kind = kind

class Observation:
    
    def __init__(self, data):
        self.data = data
        self.parse(data)

    def parse(self, data):
        ''' {
                'source-id:"streamrSpoof",'
                'stream-id:"simpleEURCleaned",'
                'observation-id': 3675, 
                'observed-time': "2022-02-16 02:52:45.794120", 
                'content': {
                    'High': 0.81856, 
                    'Low': 0.81337, 
                    'Close': 0.81512}}
            note: if observed-time is missing, define it here.
        '''
        j = json.loads(data)
        self.sourceId = j['source-id']
        self.streamId = j['stream-id']
        self.observedTime = j.get('observed-time', str(dt.datetime.utcnow()))
        self.observationId = j['observation-id']
        self.content = j['content']
        if isinstance(self.content, dict):
            self.df = pd.DataFrame(
                {(self.sourceId, self.streamId, target): values for target, values in list(self.content.items()) + [('StreamObservationId', self.observationId)]},
                #columns=pd.MultiIndex.from_tuples([(self.sourceId, self.streamId, self.)]),
                index=[self.observedTime])
        elif not isinstance(self.content, dict):
            self.df = pd.DataFrame(
                {(self.sourceId, self.streamId, self.streamId): [self.content] + [('StreamObservationId', self.observationId)]}, 
                index=[self.observedTime])
