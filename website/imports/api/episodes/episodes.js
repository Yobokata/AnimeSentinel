import SimpleSchema from 'simpl-schema';
import Streamers, {TempShow} from '../../streamers/streamers';
import {Shows} from '../shows/shows';

// Collection
export const Episodes = new Mongo.Collection('episodes');

// Schema
Schemas.Episode = new SimpleSchema({
  _id: {
    type: String,
    optional: true
  },

  showId: {
    type: String,
    index: true
  },
  episodeNumStart: {
    type: Number,
    index: true
  },
  episodeNumEnd: {
    type: Number,
    index: true
  },
  notes: {
    type: String,
    index: true,
    optional: true
  },
  translationType: {
    type: String,
    allowedValues: ['sub', 'dub', 'raw'],
    index: true
  },
  streamerId: {
    type: String,
    index: true
  },
  sourceName: {
    type: String,
    index: true
  },

  sourceUrl: {
    type: String
  },
  flags: {
    type: Array,
    optional: true,
    autoValue: function() {
      if ((!this.isSet || !this.value) && !this.isUpdate) {
        return [];
      }
      if (!this.isSet) {
        return undefined;
      }
      return this.value.reduce((total, value) => {
        value = value.trim();
        if (value && !total.includes(value)) {
          total.push(value);
        }
        return total;
      }, []);
    }
  },
  'flags.$': {
    type: String,
    allowedValues: ['flash', 'cloudflare', 'x-frame-options', 'mixed-content', 'requires-plugins']
  },
  uploadDate: {
    type: Object,
    index: true,
    optional: true,
    defaultValue: {}
  },
  'uploadDate.year': {
    type: SimpleSchema.Integer,
    optional: true
  },
  'uploadDate.month': {
    type: SimpleSchema.Integer,
    optional: true
  },
  'uploadDate.date': {
    type: SimpleSchema.Integer,
    optional: true
  },
  'uploadDate.hour': {
    type: SimpleSchema.Integer,
    optional: true
  },
  'uploadDate.minute': {
    type: SimpleSchema.Integer,
    optional: true
  }
}, { tracker: Tracker });

Episodes.attachSchema(Schemas.Episode);

// Constants
Episodes.flagsWithoutAddOnPreference = ['cloudflare', 'mixed-content', 'flash'];
Episodes.flagsWithoutAddOnNever = ['x-frame-options'];
Episodes.flagsWithAddOnPreference = ['flash', 'mixed-content'];
Episodes.flagsWithAddOnNever = [];
Episodes.flagsWithSandboxingNever = ['requires-plugins'];
Episodes.objectKeys = Schemas.Episode._schemaKeys.filter((key) => {
  return !key.includes('.') && Schemas.Episode._schema[key].type.definitions[0].type.toString().includes('Object()');
});
Episodes.informationKeys = ['sourceUrl', 'flags', 'uploadDate'];

// Helpers
Episodes.helpers({
  remove() {
    Episodes.remove(this._id);
  },

  translationTypeExpanded() {
    return this.translationType.replace('dub', 'dubbed').replace('sub', 'subbed').capitalize();
  },

  notesEncoded() {
    if (this.notes) {
      return encodeBase64(this.notes);
    } else {
      return 'none';
    }
  },

  mergeEpisode(other) {
    // Copy and merge attributes
    Object.keys(other).forEach((key) => {
      if (Episodes.informationKeys.includes(key) && (!Episodes.objectKeys.includes(key) || Object.countNonEmptyValues(other[key]) > Object.countNonEmptyValues(this[key]))) {
        this[key] = other[key];
      }
    });

    // Update database
    Episodes.update(this._id, {
      $set: Schemas.Episode.clean(this, {
        mutate: true
      })
    });

    // Remove other from database
    if (other._id) {
      other.remove();
    }
  },

  moveToShow(showId) {
    this.showId = showId;
    Episodes.remove(this._id);
    Episodes.addEpisode(this);
  }
});

Episodes.addEpisode = function(episode) {
  let id = undefined;

  // Get episodes which are the same
  let others = Episodes.queryUnique(episode.showId, episode.translationType, episode.episodeNumStart, episode.episodeNumEnd, episode.notes, episode.streamerId, episode.sourceName);

  // Merge episodes if found
  if (others.count()) {
    let firstOther = undefined;

    others.forEach((other) => {
      if (!firstOther) {
        firstOther = other;
      } else {
        firstOther.mergeEpisode(other);
      }
    });

    if (firstOther) {
      firstOther.mergeEpisode(episode);
      id = firstOther._id;
    }
  }

  // Insert otherwise
  else {
    id = Episodes.insert(episode);
  }

  // Recalculate certain attributes for the related show
  let show = Shows.findOne(episode.showId);
  if (show) {
    show.afterNewEpisode(episode);
  }

  // Return id
  return id;
};

Episodes.moveEpisodes = function(fromId, toId) {
  Episodes.queryForShow(fromId).forEach((episode) => {
    episode.moveToShow(toId);
  });
};

Episodes.isFlagProblematic = function(flag) {
  return (getStorageItem('FrameSandboxingEnabled') && Episodes.flagsWithSandboxingNever.includes(flag) && BrowserDetect.browser === 'Chrome') ||
    (Session.get('AddOnInstalled') && (Episodes.flagsWithAddOnPreference.includes(flag) || Episodes.flagsWithAddOnNever.includes(flag))) ||
    (!Session.get('AddOnInstalled') && (Episodes.flagsWithoutAddOnPreference.includes(flag) || Episodes.flagsWithoutAddOnNever.includes(flag)));
};

Episodes.isFlagDisabled = function(flag) {
  return (getStorageItem('FrameSandboxingEnabled') && Episodes.flagsWithSandboxingNever.includes(flag) && BrowserDetect.browser === 'Chrome') ||
    (Session.get('AddOnInstalled') && Episodes.flagsWithAddOnNever.includes(flag)) ||
    (!Session.get('AddOnInstalled') && Episodes.flagsWithoutAddOnNever.includes(flag));
};

Episodes.findRecentEpisodes = function() {
  // For each streamer
  Streamers.getStreamers().forEach((streamer) => {
    // Download and process recent page
    Streamers.getRecentResults(streamer.recentPage, streamer, undefined, (results) => {
      // For each result
      results.forEach((result) => {

        // Add as partial
        Shows.addPartialShow(result.show);

        // Process show in simple mode when episodes are missing
        if (result.missing) {
          let tempShow = new TempShow(result.show, (partial, episodes) => {

            Shows.addPartialShow(partial, episodes);

          }, (partial, episodes) => {

            Shows.addPartialShow(partial, episodes);

          }, (partial) => {

            result.show = partial;
            Shows.addPartialShow(result.show);
            delete partial._id;

          }, (episode) => {

            Shows.queryMatchingShows(result.show).forEach((show) => {
              episode.showId = show._id;
              Episodes.addEpisode(episode);
              delete episode._id;
            });

          }, true);
          tempShow.start();
        }

      });
    });
  });
};

Episodes.getPreviousEpisode = function(showId, translationType, episodeNumStart, episodeNumEnd, notes) {
  let episodes = Episodes.queryForTranslationType(showId, translationType).fetch();

  for (let i = episodes.length - 1; i >= 0; i--) {
    if (episodes[i].episodeNumStart === episodeNumStart && episodes[i].episodeNumEnd === episodeNumEnd && episodes[i].notes === notes) {
      return episodes[i + 1];
    }
  }
};

Episodes.getNextEpisode = function(showId, translationType, episodeNumStart, episodeNumEnd, notes) {
  let episodes = Episodes.queryForTranslationType(showId, translationType).fetch();

  for (let i = 0; i < episodes.length; i++) {
    if (episodes[i].episodeNumStart === episodeNumStart && episodes[i].episodeNumEnd === episodeNumEnd && episodes[i].notes === notes) {
      return episodes[i - 1];
    }
  }
};

// Methods
Meteor.methods({
  'episodes.findRecentEpisodes'() {
    // TODO: Make this work better (remove / make caching + indicator work)
    Episodes.findRecentEpisodes();
  }
});

// Queries
Episodes.queryForShow = function(showId) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
  }, {
    keys: ['showId']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId
  });
};

Episodes.queryForTranslationType = function(showId, translationType) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
    translationType: translationType
  }, {
    keys: ['showId', 'translationType']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId,
    translationType: translationType
  }, {
    sort: {
      episodeNumEnd: -1,
      episodeNumStart: -1,
      notes: -1,
      'uploadDate.year': 1,
      'uploadDate.month': 1,
      'uploadDate.date': 1,
      'uploadDate.hour': 1,
      'uploadDate.minute': 1
    }
  });
};

Episodes.queryForEpisode = function (showId, translationType, episodeNumStart, episodeNumEnd, notes) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
    translationType: translationType,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes
  }, {
    keys: ['showId', 'translationType', 'episodeNumStart', 'episodeNumEnd', 'notes']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes,
    translationType: translationType
  });
};

Episodes.queryForStreamer = function (showId, translationType, episodeNumStart, episodeNumEnd, notes, streamerId) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
    translationType: translationType,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes,
    streamerId: streamerId
  }, {
    keys: ['showId', 'translationType', 'episodeNumStart', 'episodeNumEnd', 'streamerId', 'notes']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes,
    translationType: translationType,
    streamerId: streamerId
  });
};

Episodes.queryUnique = function (showId, translationType, episodeNumStart, episodeNumEnd, notes, streamerId, sourceName) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
    translationType: translationType,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes,
    streamerId: streamerId,
    sourceName: sourceName
  }, {
    keys: ['showId', 'translationType', 'episodeNumStart', 'episodeNumEnd', 'streamerId', 'sourceName', 'notes']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId,
    episodeNumStart: episodeNumStart,
    episodeNumEnd: episodeNumEnd,
    notes: notes,
    translationType: translationType,
    streamerId: streamerId,
    sourceName: sourceName
  });
};

Episodes.queryRecent = function(limit) {
  // Validate
  new SimpleSchema({
    limit: {
      type: SimpleSchema.Integer
    }
  }).validate({limit});

  // Return results cursor
  return Episodes.find({}, {
    limit: limit,
    sort: {
      'uploadDate.year': -1,
      'uploadDate.month': -1,
      'uploadDate.date': -1,
      'uploadDate.hour': -1,
      'uploadDate.minute': -1,
      showId: -1,
      translationType: -1,
      episodeNumEnd: -1,
      episodeNumStart: -1,
      notes: -1
    }
  })
};

Episodes.queryToWatch = function(showId, translationType, lastWatched) {
  // Validate
  Schemas.Episode.validate({
    showId: showId,
    translationType: translationType,
    episodeNumEnd: lastWatched
  }, {
    keys: ['showId', 'translationType', 'episodeNumEnd']
  });

  // Return results cursor
  return Episodes.find({
    showId: showId,
    translationType: translationType,
    episodeNumEnd: {
      $gt: lastWatched
    }
  }, {
    sort: {
      episodeNumStart: 1,
      episodeNumEnd: 1,
      notes: -1
    }
  });
};
