<?php

namespace App\AnimeSentinel;

use App\Streamer;
use App\Video;

class VideoManager
{
  /**
   * Saves the passed in video objects after:
   * 1. Setting the cache_updated_at property to the current date and time
   */
  public static function saveVideos($videos) {
    foreach ($videos as $video) {
      $video->cache_updated_at = Carbon::now();
      $video->save();
    }
  }

  /**
   * Finds the video link for the requested video from it's streaming site.
   *
   * @return string
   */
  public static function findVideoLink($video) {
    $class = '\\App\\AnimeSentinel\\Connectors\\'.$video->streamer_id;
    return $class::findVideoLink($video);
  }

  /**
   * Removes and adds all videos for the requested show and episode.
   */
  public static function reprocessEpsiode($show, $translation_types, $episode_num, $streamer_id = null) {
    // Mark show as not initialised
    $show->videos_initialised = false;
    $show->save();
    // Grab all streamers data
    $streamers = Streamer::all();

    // For all applicable streamers, request videos for this episode
    $videosRaw = []; $videos = [];
    foreach ($streamers as $streamer) {
      if (($streamer_id === null || $streamer_id === $streamer->id) && ($streamer->id !== 'youtube' || (!empty($show->show_flags) && $show->show_flags->check_youtube))) {
        $class = '\\App\\AnimeSentinel\\Connectors\\'.$streamer->id;
        $videosRaw = array_merge($videosRaw, $class::seek($show, $episode_num));
      }
    }
    foreach ($videosRaw as $video) {
      if (in_array($video->translation_type, $translation_types)) {
        $videos[] = $video;
      }
    }

    // Remove all existing videos for this episode
    foreach ($translation_types as $translation_type) {
      if ($streamer_id === null) {
        $show->videos()->episode($translation_type, $episode_num)->delete();
      } else {
        $show->videos()->episode($translation_type, $episode_num)->where('streamer_id', $streamer_id)->delete();
      }
    }
    // Save the new videos
    Self::saveVideos($videos);
    // Mark show as initialised
    $show->videos_initialised = true;
    $show->save();
  }
}
